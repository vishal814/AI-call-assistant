import express from 'express';
import bodyParser from 'body-parser';
import twilio from 'twilio';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import WebSocket, { WebSocketServer } from 'ws';

import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// Environment variables
const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_TOKEN = process.env.TWILIO_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MONGO_URI = process.env.MONGO_URI;

// Validate required environment variables
const requiredEnvVars = {
    TWILIO_SID,
    TWILIO_TOKEN,
    TWILIO_NUMBER,
    OPENAI_API_KEY
};

for (const [key, value] of Object.entries(requiredEnvVars)) {
    if (!value) {
        console.error(`❌ Missing required environment variable: ${key}`);
        console.error('Please check your .env file and ensure all required variables are set.');
        process.exit(1);
    }
}

// MongoDB is optional - warn if not provided
if (!MONGO_URI) {
    console.warn('⚠️ MONGO_URI not provided - conversation logging will be disabled');
}

// Initialize services
const twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// MongoDB connection with better error handling
let db;
let mongoClient;

async function connectMongoDB() {
    try {
        const options = {
            serverSelectionTimeoutMS: 30000, // Timeout after 30s (default)
            socketTimeoutMS: 45000, // Close sockets after 45s of inactivity
            maxPoolSize: 10, // Maintain up to 10 socket connections
            family: 4, // Use IPv4, skip trying IPv6
            retryWrites: true,
            w: 'majority'
        };

        mongoClient = new MongoClient(MONGO_URI, options);
        await mongoClient.connect();
        
        // Test the connection
        await mongoClient.db('admin').command({ ping: 1 });
        
        db = mongoClient.db('ai_voice_assistant');
        console.log('✅ MongoDB: Connected successfully');
        
        // Create indexes for better performance
        await db.collection('conversations').createIndex({ callSid: 1, timestamp: -1 });
        await db.collection('call_logs').createIndex({ callSid: 1, timestamp: -1 });
        
        console.log('📊 MongoDB: Ready for conversation logging');
        
    } catch (error) {
        console.warn('⚠️ MongoDB connection failed, continuing without database logging:', error.message);
        console.log('� MongoDaB: Disabled - Voice assistant will work without conversation logging');
        db = null;
    }
}

// Connect to MongoDB
connectMongoDB();



// Middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Add logging middleware for debugging
app.use((req, res, next) => {
    if (req.path.startsWith('/voice/')) {
        console.log(`🔍 ${req.method} ${req.path}`, {
            contentType: req.headers['content-type'],
            bodySize: req.headers['content-length'],
            hasBody: !!req.body
        });
    }
    next();
});

app.use(express.static('public'));



// Store active calls and conversations
const activeCalls = new Map();
const conversationMemory = new Map();

// AI Voice Call Assistant Class
class AIVoiceCallAssistant {
    constructor() {
        this.supportedLanguages = {
            'en': { name: 'English', voice: 'alloy', whisperLang: 'en' },
            'es': { name: 'Spanish', voice: 'nova', whisperLang: 'es' },
            'fr': { name: 'French', voice: 'shimmer', whisperLang: 'fr' },
            'de': { name: 'German', voice: 'echo', whisperLang: 'de' },
            'it': { name: 'Italian', voice: 'fable', whisperLang: 'it' },
            'pt': { name: 'Portuguese', voice: 'onyx', whisperLang: 'pt' }
        };
    }

    // Initialize call session
    async initializeCall(callSid, fromNumber, language = 'en') {
        const callSession = {
            callSid,
            fromNumber,
            language,
            startTime: new Date(),
            conversationHistory: [],
            audioBuffer: [],
            isActive: true,
            contextWindow: []
        };

        activeCalls.set(callSid, callSession);
        
        // Log call initiation to MongoDB
        await this.logCallEvent(callSid, 'call_initiated', {
            fromNumber,
            language,
            timestamp: new Date()
        });

        return callSession;
    }

    // Speech-to-Text using OpenAI Whisper
    async transcribeAudio(audioBuffer, language = 'en') {
        try {
            const tempFile = path.join(__dirname, 'temp', `audio_${Date.now()}.wav`);
            
            // Ensure temp directory exists
            if (!fs.existsSync(path.join(__dirname, 'temp'))) {
                fs.mkdirSync(path.join(__dirname, 'temp'));
            }

            // Write audio buffer to temporary file
            fs.writeFileSync(tempFile, audioBuffer);

            const transcription = await openai.audio.transcriptions.create({
                file: fs.createReadStream(tempFile),
                model: 'whisper-1',
                language: this.supportedLanguages[language]?.whisperLang || 'en',
                response_format: 'text'
            });

            // Clean up temp file
            fs.unlinkSync(tempFile);

            return transcription;
        } catch (error) {
            console.error('STT Error:', error);
            return null;
        }
    }

    // Generate AI response with context
    async generateResponse(callSid, userMessage, retryCount = 0) {
        try {
            const callSession = activeCalls.get(callSid);
            if (!callSession) throw new Error('Call session not found');

            // Add user message to conversation history
            callSession.conversationHistory.push({
                role: 'user',
                content: userMessage,
                timestamp: new Date()
            });

            // Build context-aware messages
            const messages = [
                {
                    role: 'system',
                    content: `You are an AI voice assistant speaking in ${this.supportedLanguages[callSession.language].name}. 
                    Keep responses conversational, natural, and under 100 words. 
                    You're having a phone conversation, so speak as if talking directly to the person.
                    Be helpful, friendly, and engaging.`
                }
            ];

            // Add conversation history (last 10 messages for context)
            const recentHistory = callSession.conversationHistory.slice(-10);
            for (const msg of recentHistory) {
                messages.push({
                    role: msg.role,
                    content: msg.content
                });
            }

            const completion = await openai.chat.completions.create({
                model: 'gpt-4o',
                messages: messages,
                max_tokens: 150,
                temperature: 0.7,
                presence_penalty: 0.1,
                frequency_penalty: 0.1
            });

            const aiResponse = completion.choices[0].message.content;

            // Add AI response to conversation history
            callSession.conversationHistory.push({
                role: 'assistant',
                content: aiResponse,
                timestamp: new Date()
            });

            // Log conversation to MongoDB
            await this.logConversation(callSid, userMessage, aiResponse);

            return aiResponse;

        } catch (error) {
            console.error('LLM Error:', error);
            
            // Retry logic with exponential backoff
            if (retryCount < 3) {
                const delay = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.generateResponse(callSid, userMessage, retryCount + 1);
            }
            
            return "I'm sorry, I'm having trouble processing your request right now. Could you please try again?";
        }
    }

    // Text-to-Speech with language support
    async generateSpeech(text, language = 'en', callSid) {
        try {
            const voice = this.supportedLanguages[language]?.voice || 'alloy';
            
            const mp3 = await openai.audio.speech.create({
                model: "tts-1",
                voice: voice,
                input: text,
                speed: 1.0
            });

            const audioBuffer = Buffer.from(await mp3.arrayBuffer());
            
            // Save audio for debugging/logging
            const filename = `call_${callSid}_${Date.now()}.mp3`;
            const audioPath = path.join(__dirname, 'public', 'call_audio', filename);
            
            // Ensure directory exists
            if (!fs.existsSync(path.join(__dirname, 'public', 'call_audio'))) {
                fs.mkdirSync(path.join(__dirname, 'public', 'call_audio'), { recursive: true });
            }

            fs.writeFileSync(audioPath, audioBuffer);
            
            console.log(`✅ TTS Audio generated: ${filename}`);
            return audioBuffer;

        } catch (error) {
            console.error('TTS Error:', error);
            return null;
        }
    }

    // Log conversation to MongoDB
    async logConversation(callSid, userMessage, aiResponse) {
        try {
            if (!db) return;

            await db.collection('conversations').insertOne({
                callSid,
                userMessage,
                aiResponse,
                timestamp: new Date(),
                sessionId: uuidv4()
            });
        } catch (error) {
            console.error('MongoDB logging error:', error);
        }
    }

    // Log call events
    async logCallEvent(callSid, eventType, data) {
        try {
            if (!db) return;

            await db.collection('call_logs').insertOne({
                callSid,
                eventType,
                data,
                timestamp: new Date()
            });
        } catch (error) {
            console.error('Call logging error:', error);
        }
    }

    // End call session
    async endCall(callSid) {
        const callSession = activeCalls.get(callSid);
        if (callSession) {
            callSession.isActive = false;
            callSession.endTime = new Date();
            
            // Log call completion
            await this.logCallEvent(callSid, 'call_ended', {
                duration: callSession.endTime - callSession.startTime,
                messageCount: callSession.conversationHistory.length
            });

            activeCalls.delete(callSid);
        }
    }
}

const voiceAssistant = new AIVoiceCallAssistant();

// Routes

// Dashboard
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>AI Voice Call Assistant</title>
            <style>
                body { font-family: Arial, sans-serif; max-width: 1000px; margin: 0 auto; padding: 20px; }
                .container { background: #f5f5f5; padding: 20px; border-radius: 10px; }
                .feature { background: white; margin: 10px 0; padding: 15px; border-radius: 5px; }
                .status { color: #28a745; font-weight: bold; }
                .call-btn { background: #007bff; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; }
                .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>📞 AI Voice Call Assistant</h1>
                <p class="status">✅ Server running on port ${port}</p>
                
                <div class="stats">
                    <div class="feature">
                        <h3>📊 Active Calls</h3>
                        <p><strong>${activeCalls.size}</strong> ongoing conversations</p>
                    </div>
                    <div class="feature">
                        <h3>🌍 Languages</h3>
                        <p><strong>6</strong> supported languages</p>
                    </div>
                    <div class="feature">
                        <h3>📱 Call Number</h3>
                        <p><strong>${TWILIO_NUMBER}</strong></p>
                        <button class="call-btn" onclick="window.open('tel:${TWILIO_NUMBER}')">📞 Call Now</button>
                    </div>
                </div>

                <div class="feature">
                    <h3>🎤 Voice Features</h3>
                    <p>• Real-time speech-to-text (Whisper)</p>
                    <p>• Live AI responses (GPT-4o)</p>
                    <p>• Natural text-to-speech</p>
                    <p>• Multi-language support</p>
                    <p>• Conversation memory & context</p>
                </div>

                <div class="feature">
                    <h3>🔧 Supported Languages</h3>
                    <p>English, Spanish, French, German, Italian, Portuguese</p>
                </div>

                <div class="feature">
                    <h3>📈 Call Analytics</h3>
                    <p>All conversations logged to MongoDB with full context and analytics</p>
                </div>
            </div>
        </body>
        </html>
    `);
});

// Incoming call webhook
app.post('/voice/incoming', async (req, res) => {
    // Debug logging
    console.log('📋 Webhook received:', {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: req.body
    });

    // Check if body exists and has required fields
    if (!req.body) {
        console.error('❌ No request body received');
        return res.status(400).send('Bad Request: No body');
    }

    const callSid = req.body.CallSid;
    const fromNumber = req.body.From;

    if (!callSid || !fromNumber) {
        console.error('❌ Missing required fields:', { callSid, fromNumber });
        return res.status(400).send('Bad Request: Missing CallSid or From');
    }
    
    console.log(`📞 Incoming call from ${fromNumber} (${callSid})`);

    // Initialize call session
    await voiceAssistant.initializeCall(callSid, fromNumber);

    // TwiML response to handle the call
    const twiml = `
        <Response>
            <Say voice="alice" language="en-US">
                Hello! You've reached the AI Voice Assistant. I can help you with questions and have a conversation. 
                Please speak after the tone.
            </Say>
            <Gather input="speech" timeout="5" speechTimeout="auto" action="/voice/process" method="POST">
                <Say voice="alice">I'm listening...</Say>
            </Gather>
            <Say voice="alice">I didn't hear anything. Please call back if you'd like to chat!</Say>
        </Response>
    `;

    res.set('Content-Type', 'text/xml');
    res.send(twiml);
});

// Process speech input
app.post('/voice/process', async (req, res) => {
    // Check if body exists
    if (!req.body) {
        console.error('❌ No request body received in /voice/process');
        return res.status(400).send('Bad Request: No body');
    }

    const callSid = req.body.CallSid;
    const speechResult = req.body.SpeechResult;
    const confidence = req.body.Confidence;

    if (!callSid) {
        console.error('❌ Missing CallSid in /voice/process');
        return res.status(400).send('Bad Request: Missing CallSid');
    }
    
    console.log(`🎤 Speech received (${callSid}): "${speechResult}" (confidence: ${confidence})`);

    try {
        if (!speechResult || confidence < 0.5) {
            // Low confidence or no speech
            const twiml = `
                <Response>
                    <Say voice="alice">I didn't quite catch that. Could you please repeat?</Say>
                    <Gather input="speech" timeout="5" speechTimeout="auto" action="/voice/process" method="POST">
                        <Say voice="alice">I'm listening...</Say>
                    </Gather>
                </Response>
            `;
            res.set('Content-Type', 'text/xml');
            return res.send(twiml);
        }

        // Generate AI response
        const aiResponse = await voiceAssistant.generateResponse(callSid, speechResult);
        
        // Continue conversation
        const twiml = `
            <Response>
                <Say voice="alice">${aiResponse}</Say>
                <Gather input="speech" timeout="5" speechTimeout="auto" action="/voice/process" method="POST">
                    <Say voice="alice">What else can I help you with?</Say>
                </Gather>
                <Say voice="alice">Thank you for calling! Have a great day!</Say>
                <Hangup/>
            </Response>
        `;

        res.set('Content-Type', 'text/xml');
        res.send(twiml);

    } catch (error) {
        console.error('Voice processing error:', error);
        
        const twiml = `
            <Response>
                <Say voice="alice">I'm sorry, I'm having technical difficulties. Please try calling again later.</Say>
                <Hangup/>
            </Response>
        `;
        
        res.set('Content-Type', 'text/xml');
        res.send(twiml);
    }
});

// Call status webhook
app.post('/voice/status', async (req, res) => {
    // Check if body exists
    if (!req.body) {
        console.error('❌ No request body received in /voice/status');
        return res.status(400).send('Bad Request: No body');
    }

    const callSid = req.body.CallSid;
    const callStatus = req.body.CallStatus;

    if (!callSid) {
        console.error('❌ Missing CallSid in /voice/status');
        return res.status(400).send('Bad Request: Missing CallSid');
    }
    
    console.log(`📞 Call ${callSid} status: ${callStatus}`);

    if (callStatus === 'completed' || callStatus === 'failed' || callStatus === 'busy' || callStatus === 'no-answer') {
        await voiceAssistant.endCall(callSid);
    }

    res.sendStatus(200);
});

// Outbound call initiation
app.post('/api/call', async (req, res) => {
    const { phoneNumber, language = 'en', webhookUrl } = req.body;
    
    if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number is required' });
    }

    // Check if we have a valid webhook URL
    const baseUrl = webhookUrl || process.env.NGROK_URL || `${req.protocol}://${req.get('host')}`;
    
    // Validate that the URL is accessible (not localhost for production)
    if (baseUrl.includes('localhost') && !webhookUrl) {
        return res.status(400).json({ 
            error: 'Webhook URL required. Please provide webhookUrl in request body or set NGROK_URL environment variable.',
            example: {
                phoneNumber: '+1234567890',
                webhookUrl: 'https://your-ngrok-url.ngrok-free.app'
            }
        });
    }

    try {
        console.log(`📞 Initiating outbound call to ${phoneNumber}`);
        console.log(`🌐 Using webhook URL: ${baseUrl}`);

        const call = await twilioClient.calls.create({
            to: phoneNumber,
            from: TWILIO_NUMBER,
            url: `${baseUrl}/voice/incoming`,
            statusCallback: `${baseUrl}/voice/status`,
            statusCallbackMethod: 'POST'
        });

        res.json({
            success: true,
            callSid: call.sid,
            status: call.status,
            message: 'Call initiated successfully',
            webhookUrl: baseUrl
        });

    } catch (error) {
        console.error('Outbound call error:', error);
        res.status(500).json({ 
            error: 'Failed to initiate call',
            details: error.message,
            code: error.code
        });
    }
});

// Test endpoint for API validation (no real call)
app.post('/api/call/test', async (req, res) => {
    const { phoneNumber, language = 'en', webhookUrl } = req.body;
    
    if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number is required' });
    }

    const baseUrl = webhookUrl || process.env.NGROK_URL || `${req.protocol}://${req.get('host')}`;
    
    // Simulate successful call creation
    res.json({
        success: true,
        callSid: 'TEST_' + Date.now(),
        status: 'test-mode',
        message: 'Call would be initiated successfully (test mode)',
        config: {
            to: phoneNumber,
            from: TWILIO_NUMBER,
            language: language,
            webhookUrl: `${baseUrl}/voice/incoming`,
            statusCallback: `${baseUrl}/voice/status`
        }
    });
});

// API endpoint for direct messaging (for testing)
// app.post('/api/message', async (req, res) => {
//     const { message, phoneNumber = 'web-user' } = req.body;
    
//     if (!message) {
//         return res.status(400).json({ error: 'Message is required' });
//     }

//     try {
//         // Create a temporary call session for testing
//         const testCallSid = 'TEST_' + Date.now();
//         await voiceAssistant.initializeCall(testCallSid, phoneNumber);
        
//         // Generate AI response
//         const response = await voiceAssistant.generateResponse(testCallSid, message);
        
//         // Generate speech audio
//         const audioFilename = `response_${Date.now()}.mp3`;
//         const audioBuffer = await voiceAssistant.generateSpeech(response, 'en', testCallSid);
        
//         res.json({
//             response,
//             audioUrl: audioBuffer ? `/public/call_audio/${audioFilename}` : null
//         });
//     } catch (error) {
//         console.error('Error processing API message:', error);
//         res.status(500).json({ error: 'Error processing message' });
//     }
// });

// Get call analytics
app.get('/api/analytics', async (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({ error: 'Database not connected' });
        }

        const [callStats, recentConversations] = await Promise.all([
            db.collection('call_logs').aggregate([
                { $group: { _id: '$eventType', count: { $sum: 1 } } }
            ]).toArray(),
            db.collection('conversations').find({})
                .sort({ timestamp: -1 })
                .limit(10)
                .toArray()
        ]);

        res.json({
            activeCalls: activeCalls.size,
            callStats,
            recentConversations,
            supportedLanguages: Object.keys(voiceAssistant.supportedLanguages)
        });

    } catch (error) {
        console.error('Analytics error:', error);
        res.status(500).json({ error: 'Failed to fetch analytics' });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        services: {
            twilio: 'connected',
            openai: 'connected (GPT-4o + Whisper + TTS)',
            mongodb: db ? 'connected' : 'disconnected'
        },
        activeCalls: activeCalls.size,
        supportedLanguages: Object.keys(voiceAssistant.supportedLanguages).length
    });
});

// Graceful shutdown handler
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down gracefully...');
    
    if (mongoClient) {
        try {
            await mongoClient.close();
            console.log('✅ MongoDB connection closed');
        } catch (error) {
            console.error('❌ Error closing MongoDB:', error.message);
        }
    }
    
    process.exit(0);
});

// Start server
const server = app.listen(port, () => {
    console.log(`📞 AI Voice Call Assistant running on port ${port}`);
    console.log(`🎤 Voice webhook: http://localhost:${port}/voice/incoming`);
    console.log(`🌐 Dashboard: http://localhost:${port}`);
    console.log(`📞 Call Number: ${TWILIO_NUMBER}`);
    console.log(`🌍 Supported Languages: ${Object.keys(voiceAssistant.supportedLanguages).join(', ')}`);
    console.log(`📊 MongoDB: Connecting...`);
});

// WebSocket server for real-time updates (optional)
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    console.log('📡 WebSocket client connected');
    
    ws.on('message', (message) => {
        console.log('📨 WebSocket message:', message.toString());
    });

    ws.on('close', () => {
        console.log('📡 WebSocket client disconnected');
    });
});

export default app;
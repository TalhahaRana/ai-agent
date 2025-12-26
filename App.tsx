import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, FunctionDeclaration, Type } from '@google/genai';
import { ConnectionState, BookingDetails, LogEntry } from './types';
import { base64ToUint8Array, createPcmBlob, decodeAudioData } from './utils/audio';
import Visualizer from './components/Visualizer';

// --- Constants & Config ---
const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-09-2025';

const SYSTEM_INSTRUCTION = `
You are 'Barnaby', the AI concierge for 'The Gilded Razor', a premium gentlemen's barber shop. 
Your tone is professional, warm, slightly vintage, and efficient. 
You are speaking over the phone. Keep responses relatively concise but polite.

Your goal is to book appointments. 
Services available: 
1. The Gentleman's Cut ($45)
2. Royal Shave ($35)
3. Beard Trim & Sculpt ($30)
4. The Full Service (Cut & Shave) ($75)

You must collect the following information from the user:
1. Name
2. Service requested
3. Preferred Date & Time
4. Email address for confirmation

IMPORTANT Rules for Tool Use:
1. **Real-time Form Updates**: As soon as you receive ANY new piece of information (e.g., the user mentions "John" or "Friday at 2pm"), you MUST immediately call the 'update_draft_booking' tool. Do not wait for the turn to end. Use this tool frequently to keep the screen updated.
2. **Finalization**: Only when you have ALL details (Name, Service, Date, Time, Email) and the user agrees to proceed, call the 'book_appointment' function.

Start the conversation immediately by greeting the user warmly as 'Barnaby' and asking how you can help them.
`;

const updateDraftBookingTool: FunctionDeclaration = {
  name: 'update_draft_booking',
  description: 'Updates the visual booking ticket on the user\'s screen. Call this tool immediately whenever the user provides a new piece of information (name, service, date, time, or email).',
  parameters: {
    type: Type.OBJECT,
    properties: {
      customerName: { type: Type.STRING },
      serviceType: { type: Type.STRING },
      date: { type: Type.STRING },
      time: { type: Type.STRING },
      email: { type: Type.STRING },
    },
  },
};

const bookAppointmentTool: FunctionDeclaration = {
  name: 'book_appointment',
  description: 'Finalizes the booking and triggers the confirmation email. Use this ONLY when all details are collected and confirmed.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      customerName: { type: Type.STRING },
      serviceType: { type: Type.STRING },
      date: { type: Type.STRING },
      time: { type: Type.STRING },
      email: { type: Type.STRING },
    },
    required: ['customerName', 'serviceType', 'date', 'time', 'email'],
  },
};

const App: React.FC = () => {
  // State
  const [connectionState, setConnectionState] = useState<ConnectionState>(ConnectionState.DISCONNECTED);
  const [currentBooking, setCurrentBooking] = useState<Partial<BookingDetails>>({});
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [confirmedBooking, setConfirmedBooking] = useState<boolean>(false);
  const [micActive, setMicActive] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Audio Context Refs
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  
  // Logic Refs
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionRef = useRef<any>(null); // To store the session object
  const isConnectedRef = useRef<boolean>(false);

  const apiKey = process.env.API_KEY;

  const addLog = (role: LogEntry['role'], text: string) => {
    setLogs(prev => [...prev.slice(-4), { role, text, timestamp: new Date() }]);
  };

  const cleanupAudio = async () => {
    isConnectedRef.current = false;

    // 1. Stop the processor immediately to prevent new data callbacks
    if (processorRef.current) {
      processorRef.current.onaudioprocess = null;
      processorRef.current.disconnect();
      processorRef.current = null;
    }

    // 2. Stop the microphone source
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }

    // 3. Stop all media tracks (mic)
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    // 4. Stop all playing audio sources
    sourcesRef.current.forEach(source => {
      try {
        source.stop();
      } catch (e) {
        // Ignore errors if source is already stopped
      }
    });
    sourcesRef.current.clear();

    // 5. Close AudioContexts
    if (inputAudioContextRef.current && inputAudioContextRef.current.state !== 'closed') {
      await inputAudioContextRef.current.close();
      inputAudioContextRef.current = null;
    }
    
    if (outputAudioContextRef.current && outputAudioContextRef.current.state !== 'closed') {
      await outputAudioContextRef.current.close();
      outputAudioContextRef.current = null;
    }

    setMicActive(false);
  };

  const connectToGemini = async () => {
    if (!apiKey) {
      alert("API Key not found in environment.");
      return;
    }

    // Ensure clean state before connecting
    await cleanupAudio();
    setErrorMessage(null);

    try {
      setConnectionState(ConnectionState.CONNECTING);
      setConfirmedBooking(false);
      setCurrentBooking({});

      // Initialize Audio Contexts
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      const inputCtx = new AudioContext({ sampleRate: 16000 });
      const outputCtx = new AudioContext({ sampleRate: 24000 });
      inputAudioContextRef.current = inputCtx;
      outputAudioContextRef.current = outputCtx;

      // Setup Visualizer
      const analyser = outputCtx.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;

      // Get Microphone with Echo Cancellation and Noise Suppression
      // This is critical for preventing self-interruption and disconnects in noisy environments
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          autoGainControl: true,
          noiseSuppression: true,
        }
      });
      streamRef.current = stream;

      const ai = new GoogleGenAI({ apiKey });
      
      const config = {
        model: MODEL_NAME,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: SYSTEM_INSTRUCTION,
          tools: [{ functionDeclarations: [updateDraftBookingTool, bookAppointmentTool] }],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Fenrir" } }
          }
        },
      };

      // Connect to Live API
      const sessionPromise = ai.live.connect({
        ...config,
        callbacks: {
          onopen: () => {
            setConnectionState(ConnectionState.CONNECTED);
            setMicActive(true);
            isConnectedRef.current = true;
            addLog('system', 'Connected to The Gilded Razor');

            // Ensure Contexts are running (fixes some browser suspension issues)
            if (inputCtx.state === 'suspended') inputCtx.resume();
            if (outputCtx.state === 'suspended') outputCtx.resume();

            // Setup Input Streaming
            const source = inputCtx.createMediaStreamSource(stream);
            const processor = inputCtx.createScriptProcessor(4096, 1, 1);
            
            processor.onaudioprocess = (e) => {
              // Guard: stop processing if disconnected
              if (!isConnectedRef.current || !inputAudioContextRef.current || inputAudioContextRef.current.state === 'closed') return;
              
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createPcmBlob(inputData);
              
              sessionPromise.then(session => {
                 // Double check connection state inside the promise in case it changed
                 if (isConnectedRef.current) {
                    session.sendRealtimeInput({ media: pcmBlob });
                 }
              }).catch(e => {
                  console.error("Session send error", e);
              });
            };

            source.connect(processor);
            processor.connect(inputCtx.destination);
            
            sourceRef.current = source;
            processorRef.current = processor;

            // Trigger Greeting: Send a text message to the model to make it speak first
            setTimeout(() => {
                sessionPromise.then(session => {
                    session.send({ parts: [{ text: "The user has connected. Greet them warmly." }], turnComplete: true });
                });
            }, 100);
          },
          onmessage: async (message: LiveServerMessage) => {
            // 1. Handle Tool Calling
            if (message.toolCall) {
              const functionCalls = message.toolCall.functionCalls;
              for (const call of functionCalls) {
                
                // --- Tool: Update Draft ---
                if (call.name === 'update_draft_booking') {
                   const args = call.args as unknown as BookingDetails;
                   // Use functional update to merge details
                   setCurrentBooking(prev => {
                     const updated = { ...prev, ...args };
                     // Filter out empty strings if the model sends partial empty fields
                     Object.keys(updated).forEach(key => {
                        if ((updated as any)[key] === "") delete (updated as any)[key];
                     });
                     return updated;
                   });
                   addLog('system', 'Updating draft details...');
                   
                   // Respond immediately to keep flow going
                   sessionPromise.then(session => {
                    session.sendToolResponse({
                      functionResponses: {
                        id: call.id,
                        name: call.name,
                        response: { result: "ok" }
                      }
                    });
                  });
                }

                // --- Tool: Final Booking ---
                if (call.name === 'book_appointment') {
                  const args = call.args as unknown as BookingDetails;
                  
                  // Update final details
                  setCurrentBooking(args);
                  
                  // Simulate API Latency for realism
                  await new Promise(r => setTimeout(r, 500)); 
                  
                  setConfirmedBooking(true);
                  addLog('system', `Booked for ${args.customerName}`);

                  // Send response back to model
                  sessionPromise.then(session => {
                    session.sendToolResponse({
                      functionResponses: {
                        id: call.id,
                        name: call.name,
                        response: { result: "success" } 
                      }
                    });
                  });
                }
              }
            }

            // 2. Handle Audio Output
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio) {
              const ctx = outputAudioContextRef.current;
              // Guard: stop processing if disconnected
              if (!ctx || ctx.state === 'closed') return;

              // Ensure timing is sequential
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              
              try {
                  const audioBuffer = await decodeAudioData(
                    base64ToUint8Array(base64Audio),
                    ctx,
                    24000,
                    1
                  );
    
                  const source = ctx.createBufferSource();
                  source.buffer = audioBuffer;
                  
                  // Connect to analyser for visualization
                  if (analyserRef.current) {
                    source.connect(analyserRef.current);
                  }
                  analyserRef.current?.connect(ctx.destination);
    
                  source.start(nextStartTimeRef.current);
                  
                  // Advance time cursor
                  nextStartTimeRef.current += audioBuffer.duration;
                  
                  sourcesRef.current.add(source);
                  source.onended = () => sourcesRef.current.delete(source);
              } catch (err) {
                  console.error("Audio decode error", err);
              }
            }

            // 3. Handle Interruptions
            if (message.serverContent?.interrupted) {
              console.log("Model interrupted");
              sourcesRef.current.forEach(s => s.stop());
              sourcesRef.current.clear();
              if (outputAudioContextRef.current) {
                 nextStartTimeRef.current = outputAudioContextRef.current.currentTime;
              }
            }
          },
          onclose: (e) => {
            console.log("Session closed", e);
            setConnectionState(ConnectionState.DISCONNECTED);
            setMicActive(false);
            isConnectedRef.current = false;
          },
          onerror: (err) => {
            console.error("Session error", err);
            setConnectionState(ConnectionState.ERROR);
            setErrorMessage("Connection error. Please try again.");
            isConnectedRef.current = false;
          }
        }
      });
      
      sessionRef.current = sessionPromise;

    } catch (e) {
      console.error(e);
      setConnectionState(ConnectionState.ERROR);
      setErrorMessage("Failed to initialize connection.");
    }
  };

  const disconnect = async () => {
    await cleanupAudio();
    setConnectionState(ConnectionState.DISCONNECTED);
    setMicActive(false);
  };

  // --- Render Helpers ---

  return (
    <div className="min-h-screen bg-neutral-900 text-neutral-100 flex flex-col font-sans selection:bg-gold-500 selection:text-neutral-900">
      
      {/* Header */}
      <header className="p-6 border-b border-neutral-800 flex justify-between items-center bg-black/40 backdrop-blur-md sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-gold-500 rounded-full flex items-center justify-center text-black font-serif font-bold text-xl">
            G
          </div>
          <div>
            <h1 className="font-serif text-xl tracking-wider text-gold-400">THE GILDED RAZOR</h1>
            <p className="text-xs text-neutral-500 uppercase tracking-widest">Est. 1924 • AI Concierge</p>
          </div>
        </div>
        <div className={`px-3 py-1 rounded-full text-xs font-bold tracking-widest ${
          connectionState === ConnectionState.CONNECTED ? 'bg-green-900/50 text-green-400 border border-green-800' : 
          connectionState === ConnectionState.ERROR ? 'bg-red-900/50 text-red-400 border border-red-800' : 'bg-neutral-800 text-neutral-500'
        }`}>
          {connectionState}
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-grow flex flex-col lg:flex-row max-w-7xl mx-auto w-full p-6 gap-6">
        
        {/* Left Panel: Interaction & Agent Status */}
        <div className="flex-1 flex flex-col gap-6">
          
          {/* Hero / Call Action */}
          <div className="bg-neutral-800/50 rounded-2xl p-8 border border-neutral-700 flex flex-col items-center justify-center min-h-[400px] relative overflow-hidden shadow-2xl">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-neutral-800 via-neutral-900 to-black opacity-50 z-0 pointer-events-none"></div>
            
            {/* Visualizer Container */}
            <div className="w-full max-w-md mb-8 z-10 relative">
               <Visualizer analyser={analyserRef.current} isActive={connectionState === ConnectionState.CONNECTED} />
            </div>

            {/* Agent Avatar / Indicator */}
            <div className={`w-32 h-32 rounded-full border-4 flex items-center justify-center transition-all duration-500 z-10 mb-8 ${
              micActive ? 'border-gold-500 shadow-[0_0_30px_rgba(212,175,55,0.3)]' : 'border-neutral-700 grayscale'
            }`}>
               <img 
                 src="https://picsum.photos/200/200?grayscale" 
                 alt="Agent" 
                 className="w-full h-full object-cover rounded-full opacity-80" 
               />
            </div>

            {/* Controls */}
            <div className="z-10 flex flex-col items-center gap-4">
              {connectionState === ConnectionState.DISCONNECTED || connectionState === ConnectionState.ERROR ? (
                <button 
                  onClick={connectToGemini}
                  className="bg-gold-500 hover:bg-gold-400 text-black font-bold py-3 px-8 rounded-full transition-all transform hover:scale-105 shadow-lg flex items-center gap-2"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M2 3a1 1 0 011-1h2.153a1 1 0 01.986.836l.74 4.435a1 1 0 01-.54 1.06l-1.548.773a11.037 11.037 0 006.105 6.105l.774-1.548a1 1 0 011.059-.54l4.435.74a1 1 0 01.836.986V17a1 1 0 01-1 1h-2C7.82 18 2 12.18 2 5V3z" />
                  </svg>
                  Call Shop
                </button>
              ) : (
                <button 
                  onClick={disconnect}
                  className="bg-red-600 hover:bg-red-500 text-white font-bold py-3 px-8 rounded-full transition-all shadow-lg flex items-center gap-2"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M3.172 5.172a4 4 0 015.656 0L10 6.343l1.172-1.171a4 4 0 115.656 5.656L10 17.657l-6.828-6.829a4 4 0 010-5.656z" clipRule="evenodd" />
                  </svg>
                  End Call
                </button>
              )}

              {errorMessage && (
                  <p className="text-red-400 text-sm mt-2 bg-red-900/20 px-4 py-2 rounded">{errorMessage}</p>
              )}
            </div>
            
            {connectionState === ConnectionState.CONNECTING && (
              <p className="text-gold-500 mt-4 animate-pulse">Connecting to concierge...</p>
            )}
          </div>
        </div>

        {/* Right Panel: Live Booking Ticket */}
        <div className="w-full lg:w-1/3 bg-neutral-900 border border-neutral-800 rounded-2xl p-6 shadow-xl relative overflow-hidden flex flex-col">
            <div className="absolute top-0 right-0 p-4 opacity-10">
               <svg xmlns="http://www.w3.org/2000/svg" className="h-48 w-48 text-white" viewBox="0 0 20 20" fill="currentColor">
                 <path fillRule="evenodd" d="M5 4v3H4a2 2 0 00-2 2v3a2 2 0 002 2h1v2a2 2 0 002 2h6a2 2 0 002-2v-2h1a2 2 0 002-2V9a2 2 0 00-2-2h-1V4a2 2 0 00-2-2H7a2 2 0 00-2 2zm8 0H7v3h6V4zm0 8H7v4h6v-4z" clipRule="evenodd" />
               </svg>
            </div>

            <h2 className="text-gold-400 font-serif text-xl border-b border-neutral-800 pb-4 mb-6">Booking Ticket</h2>
            
            <div className="space-y-6 relative z-10 flex-grow">
               <div className="space-y-1">
                 <label className="text-neutral-500 text-xs uppercase tracking-wider">Customer Name</label>
                 <div className={`text-lg border-b border-neutral-700 pb-1 ${currentBooking.customerName ? 'text-white' : 'text-neutral-600 italic'}`}>
                   {currentBooking.customerName || "—"}
                 </div>
               </div>

               <div className="space-y-1">
                 <label className="text-neutral-500 text-xs uppercase tracking-wider">Service</label>
                 <div className={`text-lg border-b border-neutral-700 pb-1 ${currentBooking.serviceType ? 'text-white' : 'text-neutral-600 italic'}`}>
                   {currentBooking.serviceType || "—"}
                 </div>
               </div>

               <div className="grid grid-cols-2 gap-4">
                 <div className="space-y-1">
                   <label className="text-neutral-500 text-xs uppercase tracking-wider">Date</label>
                   <div className={`text-lg border-b border-neutral-700 pb-1 ${currentBooking.date ? 'text-white' : 'text-neutral-600 italic'}`}>
                     {currentBooking.date || "—"}
                   </div>
                 </div>
                 <div className="space-y-1">
                   <label className="text-neutral-500 text-xs uppercase tracking-wider">Time</label>
                   <div className={`text-lg border-b border-neutral-700 pb-1 ${currentBooking.time ? 'text-white' : 'text-neutral-600 italic'}`}>
                     {currentBooking.time || "—"}
                   </div>
                 </div>
               </div>

               <div className="space-y-1">
                 <label className="text-neutral-500 text-xs uppercase tracking-wider">Email Confirmation</label>
                 <div className={`text-lg border-b border-neutral-700 pb-1 ${currentBooking.email ? 'text-white' : 'text-neutral-600 italic'}`}>
                   {currentBooking.email || "—"}
                 </div>
               </div>
            </div>

            {/* Confirmation Stamp */}
            {confirmedBooking && (
               <div className="mt-8 border-2 border-green-500 text-green-500 p-4 rounded-lg text-center font-bold tracking-widest uppercase transform rotate-[-2deg] animate-bounce shadow-[0_0_15px_rgba(34,197,94,0.3)] bg-green-900/20">
                 Booking Confirmed
               </div>
            )}
            
            {!confirmedBooking && connectionState === ConnectionState.CONNECTED && (
               <div className="mt-8 text-center text-neutral-500 text-sm animate-pulse">
                  Concierge is listening...
               </div>
            )}
        </div>
      </main>

      {/* Footer / Logs (Hidden on mobile mostly) */}
      <footer className="p-6 text-center text-neutral-600 text-sm border-t border-neutral-800">
        <p>The Gilded Razor © 2024. Designed and developed @ <a href="https://bridgehomies.com">Bridge Homies</a></p>
      </footer>
    </div>
  );
};

export default App;
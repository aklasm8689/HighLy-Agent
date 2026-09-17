import { store } from '../../state';

export interface GeminiVoice {
  name: string;
  gender: 'Female' | 'Male';
  description: string;
}

export const GEMINI_VOICES: GeminiVoice[] = [
  { name: 'Kore', gender: 'Female', description: 'Kore - Warm, calm, natural female voice' },
  { name: 'Puck', gender: 'Male', description: 'Puck - Friendly, youthful male voice' },
  { name: 'Charon', gender: 'Male', description: 'Charon - Deep, authoritative male voice' },
  { name: 'Fenrir', gender: 'Male', description: 'Fenrir - Energetic, clear male voice' },
  { name: 'Zephyr', gender: 'Female', description: 'Zephyr - Gentle, soft female voice' },
];

function getActiveGeminiKey(): string | undefined {
  const record = store.providers.get('gemini');
  if (record?.api_key) return record.api_key;
  if (record?.keys) {
    const activeKey = record.keys.find(k => k.enabled)?.api_key;
    if (activeKey) return activeKey;
  }
  return process.env.GEMINI_API_KEY;
}

function pcmToWav(pcmBuffer: Buffer, sampleRate = 24000, numChannels = 1, bitsPerSample = 16): Buffer {
  // If already WAV header, return as is
  if (pcmBuffer.length > 4 && pcmBuffer.subarray(0, 4).toString('ascii') === 'RIFF') {
    return pcmBuffer;
  }
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

export interface GeminiTtsOptions {
  voice?: string;
}

export async function synthesizeGeminiAudio(
  text: string,
  options: GeminiTtsOptions = {}
): Promise<{ buffer: Buffer; mimeType: string }> {
  const apiKey = getActiveGeminiKey();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in Settings > Secrets or Providers');
  }

  const voiceName = options.voice || 'Kore';
  const { GoogleGenAI, Modality } = await import('@google/genai');

  const aiClient = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: { 'User-Agent': 'aistudio-build' },
    },
  });

  const response = await aiClient.models.generateContent({
    model: 'gemini-3.1-flash-tts-preview',
    contents: [{ parts: [{ text: text.trim() }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName },
        },
      },
    },
  });

  const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!base64Audio) {
    throw new Error('No audio content returned from Gemini Flash Audio model');
  }

  const rawBuffer = Buffer.from(base64Audio, 'base64');
  const wavBuffer = pcmToWav(rawBuffer, 24000);
  return {
    buffer: wavBuffer,
    mimeType: 'audio/wav',
  };
}

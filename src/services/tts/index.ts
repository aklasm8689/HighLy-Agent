import { Communicate } from 'edge-tts-universal';
import { POPULAR_EDGE_VOICES, EdgeVoice } from './edgeTts';
import { GEMINI_VOICES, GeminiVoice, synthesizeGeminiAudio } from './geminiAudio';

export interface TtsConfig {
  enabled: boolean;
  active_engine: 'edge' | 'gemini';
  edge_voice: string;
  gemini_voice: string;
  speed: number; // 0.5 to 2.0, 1.0 is normal
  pitch: number; // -50 to +50, 0 is normal
  auto_speak: boolean; // Auto-speak replies in chat
  created_at: string;
  updated_at: string;
}

export class TtsService {
  private config: TtsConfig = {
    enabled: true,
    active_engine: 'edge',
    edge_voice: 'bn-BD-PradeepNeural',
    gemini_voice: 'Kore',
    speed: 1.0,
    pitch: 0,
    auto_speak: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  getConfig(): {
    config: TtsConfig;
    edge_voices: EdgeVoice[];
    gemini_voices: GeminiVoice[];
  } {
    return {
      config: { ...this.config },
      edge_voices: POPULAR_EDGE_VOICES,
      gemini_voices: GEMINI_VOICES,
    };
  }

  updateConfig(updates: Partial<TtsConfig>): TtsConfig {
    if (updates.active_engine && (updates.active_engine === 'edge' || updates.active_engine === 'gemini')) {
      this.config.active_engine = updates.active_engine;
    }
    if (updates.edge_voice !== undefined) {
      this.config.edge_voice = updates.edge_voice;
    }
    if (updates.gemini_voice !== undefined) {
      this.config.gemini_voice = updates.gemini_voice;
    }
    if (typeof updates.speed === 'number' && !isNaN(updates.speed)) {
      this.config.speed = Math.max(0.5, Math.min(2.0, updates.speed));
    }
    if (typeof updates.pitch === 'number' && !isNaN(updates.pitch)) {
      this.config.pitch = Math.max(-50, Math.min(50, updates.pitch));
    }
    if (typeof updates.enabled === 'boolean') {
      this.config.enabled = updates.enabled;
    }
    if (typeof updates.auto_speak === 'boolean') {
      this.config.auto_speak = updates.auto_speak;
    }
    this.config.updated_at = new Date().toISOString();
    return { ...this.config };
  }

  /**
   * Synthesizes audio buffer directly
   */
  async synthesize(
    text: string,
    options: {
      engine?: 'edge' | 'gemini';
      voice?: string;
      speed?: number;
      pitch?: number;
    } = {}
  ): Promise<{ buffer: Buffer; mimeType: string; engine: 'edge' | 'gemini'; voice: string }> {
    const engine = options.engine || this.config.active_engine;
    const speed = options.speed ?? this.config.speed;
    const pitch = options.pitch ?? this.config.pitch;

    if (engine === 'gemini') {
      const voice = options.voice || this.config.gemini_voice || 'Kore';
      try {
        const { buffer, mimeType } = await synthesizeGeminiAudio(text, { voice });
        return { buffer, mimeType, engine: 'gemini', voice };
      } catch (err: any) {
        console.warn('[TTS] Gemini Audio failed, falling back to Edge TTS:', err.message);
        // Fallback to Edge TTS
        return this.synthesizeWithEdge(text, { voice: this.config.edge_voice, speed, pitch });
      }
    } else {
      const voice = options.voice || this.config.edge_voice || 'bn-BD-PradeepNeural';
      return this.synthesizeWithEdge(text, { voice, speed, pitch });
    }
  }

  private async synthesizeWithEdge(
    text: string,
    opts: { voice: string; speed: number; pitch: number }
  ): Promise<{ buffer: Buffer; mimeType: string; engine: 'edge'; voice: string }> {
    const ratePercent = Math.round((opts.speed - 1.0) * 100);
    const rateStr = ratePercent >= 0 ? `+${ratePercent}%` : `${ratePercent}%`;
    const pitchStr = opts.pitch >= 0 ? `+${opts.pitch}Hz` : `${opts.pitch}Hz`;

    const communicate = new Communicate(text, {
      voice: opts.voice,
      rate: rateStr,
      pitch: pitchStr,
    });

    const chunks: Buffer[] = [];
    for await (const chunk of communicate.stream()) {
      if (chunk.type === 'audio' && chunk.data) {
        chunks.push(chunk.data);
      }
    }

    if (chunks.length === 0) {
      throw new Error('No audio received from Edge TTS');
    }

    return {
      buffer: Buffer.concat(chunks),
      mimeType: 'audio/mpeg',
      engine: 'edge',
      voice: opts.voice,
    };
  }

  /**
   * Real-time streaming synthesis: streams audio chunks as they arrive!
   */
  async streamSynthesize(
    text: string,
    options: {
      engine?: 'edge' | 'gemini';
      voice?: string;
      speed?: number;
      pitch?: number;
    } = {},
    onChunk: (chunk: Buffer, mimeType: string) => void
  ): Promise<{ engine: 'edge' | 'gemini'; voice: string; totalBytes: number }> {
    const engine = options.engine || this.config.active_engine;
    const speed = options.speed ?? this.config.speed;
    const pitch = options.pitch ?? this.config.pitch;

    if (engine === 'gemini') {
      const voice = options.voice || this.config.gemini_voice || 'Kore';
      try {
        const { buffer, mimeType } = await synthesizeGeminiAudio(text, { voice });
        onChunk(buffer, mimeType);
        return { engine: 'gemini', voice, totalBytes: buffer.length };
      } catch (err: any) {
        console.warn('[TTS Streaming] Gemini failed, falling back to Edge TTS streaming:', err.message);
        return this.streamWithEdge(text, { voice: this.config.edge_voice, speed, pitch }, onChunk);
      }
    } else {
      const voice = options.voice || this.config.edge_voice || 'bn-BD-PradeepNeural';
      return this.streamWithEdge(text, { voice, speed, pitch }, onChunk);
    }
  }

  private async streamWithEdge(
    text: string,
    opts: { voice: string; speed: number; pitch: number },
    onChunk: (chunk: Buffer, mimeType: string) => void
  ): Promise<{ engine: 'edge'; voice: string; totalBytes: number }> {
    const ratePercent = Math.round((opts.speed - 1.0) * 100);
    const rateStr = ratePercent >= 0 ? `+${ratePercent}%` : `${ratePercent}%`;
    const pitchStr = opts.pitch >= 0 ? `+${opts.pitch}Hz` : `${opts.pitch}Hz`;

    const communicate = new Communicate(text, {
      voice: opts.voice,
      rate: rateStr,
      pitch: pitchStr,
    });

    let totalBytes = 0;
    for await (const chunk of communicate.stream()) {
      if (chunk.type === 'audio' && chunk.data) {
        totalBytes += chunk.data.length;
        onChunk(chunk.data, 'audio/mpeg');
      }
    }

    return {
      engine: 'edge',
      voice: opts.voice,
      totalBytes,
    };
  }
}

export const ttsService = new TtsService();

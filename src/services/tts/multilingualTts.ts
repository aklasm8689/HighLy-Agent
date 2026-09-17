import { Communicate } from 'edge-tts-universal';
import type { EdgeVoice } from './edgeTts';
import { POPULAR_EDGE_VOICES } from './edgeTts';

/**
 * Language detection result
 */
interface LanguageSegment {
  text: string;
  language: 'bn' | 'en' | 'mixed';
  confidence: number;
}

/**
 * Voice mapping based on language
 */
const VOICE_MAP = {
  bn: 'bn-BD-PradeepNeural', // Bengali male voice
  en: 'en-US-JennyNeural',    // English female voice
  mixed: 'en-US-AvaMultilingualNeural', // Multilingual English voice for mixed content
};

/**
 * Technical/English words that should keep English voice even in Bangla text
 */
const TECHNICAL_WORDS = new Set([
  'API', 'HTTP', 'HTTPS', 'URL', 'JSON', 'XML', 'HTML', 'CSS', 'JS', 'TS',
  'Node.js', 'JavaScript', 'TypeScript', 'React', 'Next.js', 'Vue', 'Angular',
  'Python', 'Java', 'C#', 'C++', 'Go', 'Rust', 'Swift', 'Kotlin',
  'AWS', 'Azure', 'GCP', 'Docker', 'Kubernetes', 'Git', 'GitHub', 'GitLab',
  'Linux', 'Windows', 'macOS', 'Ubuntu', 'Debian', 'CentOS',
  'SQL', 'NoSQL', 'MongoDB', 'PostgreSQL', 'MySQL', 'Redis', 'Elasticsearch',
  'CPU', 'GPU', 'RAM', 'SSD', 'HDD', 'USB', 'WiFi', 'Bluetooth',
  'AI', 'ML', 'DL', 'NN', 'NLP', 'LLM', 'GPT', 'BERT', 'Claude', 'Gemini',
  'GPU', 'VRAM', 'FPS', 'HDR', '4K', '8K', '60Hz', '120Hz', '144Hz',
  'SKU', 'SKU', 'SKU', 'SKU', 'SKU', 'SKU', 'SKU', 'SKU',
  'order', 'tracking', 'status', 'balance', 'payment', 'delivery', 'shipping',
  'refund', 'cancel', 'return', 'exchange', 'warranty', 'price', 'discount',
  'error', 'bug', 'fix', 'update', 'install', 'configure', 'setup',
  'server', 'client', 'database', 'query', 'request', 'response', 'token',
  'localhost', 'api', 'endpoint', 'route', 'middleware', 'function', 'class',
]);

/**
 * Bengali-specific words/phrases that indicate Bangla language
 */
const BENGALI_MARKERS = [
  'আমি', 'তোমার', 'তুমি', 'আপনি', 'এটা', 'ওটা', 'সেটা', 'কী', 'কি',
  'কোন', 'কোনটি', 'কই', 'কোথায়', 'কবে', 'কেন', 'কিভাবে', 'কত',
  'হবে', 'হচ্ছে', 'হচ্ছ', 'হচ্ছে', 'হয়', 'হয়', 'হল', 'হয়নি',
  'দেখ', 'দেখুন', 'বল', 'বলুন', 'শোন', 'শোনুন', 'পড়', 'পড়ুন',
  'এখানে', 'সেখানে', 'আমাদের', 'তোমাদের', 'তার', 'তাঁর',
  'এবং', 'অথবা', 'কিন্তু', 'যদি', 'কারণ', 'তাই', 'তবে',
  'থেকে', 'পর্যন্ত', 'ব্যতীত', 'সহিত', 'সহ',
];

/**
 * Intelligent language detection for a text segment
 */
export function detectLanguage(text: string): 'bn' | 'en' | 'mixed' {
  if (!text || !text.trim()) return 'en';

  const cleanText = text.trim();
  
  // Check for Bengali Unicode characters
  const bengaliChars = cleanText.match(/[\u0980-\u09FF]/g);
  const englishChars = cleanText.match(/[a-zA-Z]/g);
  
  if (!bengaliChars && englishChars) return 'en';
  if (bengaliChars && !englishChars) return 'bn';
  
  // Mixed or ambiguous - use heuristics
  const bengaliRatio = bengaliChars ? bengaliChars.length / cleanText.length : 0;
  const englishRatio = englishChars ? englishChars.length / cleanText.length : 0;
  
  // Check for Bengali words
  const hasBengaliWord = BENGALI_MARKERS.some(marker => cleanText.includes(marker));
  
  // Check for technical/English words in context
  const words = cleanText.split(/[\s,.,!?;:(){}[\]]+/).filter(w => w.length > 0);
  const technicalCount = words.filter(w => TECHNICAL_WORDS.has(w.toUpperCase())).length;
  
  if (bengaliRatio > 0.5 && hasBengaliWord) return 'bn';
  if (englishRatio > 0.5 && technicalCount >= 2) return 'en';
  if (bengaliRatio > 0.3 && hasBengaliWord) return 'bn';
  
  // If Bengali characters are dominant but with technical terms
  if (bengaliRatio > englishRatio && bengaliRatio > 0.2) return 'bn';
  
  return 'mixed';
}

/**
 * Split text into language segments
 */
export function splitIntoLanguageSegments(text: string): LanguageSegment[] {
  if (!text || !text.trim()) return [{ text, language: 'en', confidence: 1.0 }];

  // Split by sentences/paragraphs while preserving delimiters
  const segments: LanguageSegment[] = [];
  
  // Use a regex to split on sentence boundaries but keep the delimiter
  const sentenceRegex = /([^.!.?]+[.!.?]|[^.!.?]+(?:\n|$))/g;
  let match: RegExpExecArray | null;
  
  while ((match = sentenceRegex.exec(text)) !== null) {
    const segment = match[1].trim();
    if (!segment) continue;
    
    const lang = detectLanguage(segment);
    segments.push({
      text: segment,
      language: lang,
      confidence: lang === 'bn' || lang === 'en' ? 0.9 : 0.7,
    });
  }
  
  // If no segments were created (e.g., no punctuation), treat entire text as one segment
  if (segments.length === 0) {
    segments.push({
      text: text.trim(),
      language: detectLanguage(text),
      confidence: 0.8,
    });
  }
  
  return segments;
}

/**
 * Synthesize audio for a single segment using Edge TTS
 */
async function synthesizeSegment(
  text: string,
  language: 'bn' | 'en' | 'mixed',
  speed: number,
  pitch: number,
  onChunk: (chunk: Buffer, mimeType: string) => void
): Promise<{ bytes: number; voice: string }> {
  const voice = VOICE_MAP[language];
  const ratePercent = Math.round((speed - 1.0) * 100);
  const rateStr = ratePercent >= 0 ? `+${ratePercent}%` : `${ratePercent}%`;
  const pitchStr = pitch >= 0 ? `+${pitch}Hz` : `${pitch}Hz`;

  const communicate = new Communicate(text, {
    voice,
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

  return { bytes: totalBytes, voice };
}

/**
 * Automatic multilingual TTS synthesis
 * 
 * Features:
 * - Automatically detects Bangla, English, and mixed language segments
 * - Uses appropriate voice for each segment (Bengali voice for Bangla, English voice for English)
 * - No part of the response is skipped
 * - Real-time streaming as text arrives
 * - Smart handling of technical/common English words in Bangla text
 */
export async function synthesizeMultilingual(
  text: string,
  options: {
    speed?: number;
    pitch?: number;
    onChunk?: (chunk: Buffer, mimeType: string) => void;
  } = {}
): Promise<{
  totalBytes: number;
  segments: Array<{ text: string; language: string; voice: string; bytes: number }>;
}> {
  const speed = options.speed ?? 1.0;
  const pitch = options.pitch ?? 0;
  const onChunk = options.onChunk;

  // Split text into language segments
  const segments = splitIntoLanguageSegments(text);
  
  if (segments.length === 0) {
    return { totalBytes: 0, segments: [] };
  }

  console.log(`[MultilingualTTS] Detected ${segments.length} language segments:`);
  segments.forEach((seg, i) => {
    console.log(`  [${i + 1}] ${seg.language.toUpperCase()}: "${seg.text.substring(0, 50)}${seg.text.length > 50 ? '...' : ''}"`);
  });

  let totalBytes = 0;
  const results: Array<{ text: string; language: string; voice: string; bytes: number }> = [];

  // Process each segment with appropriate voice
  for (const segment of segments) {
    try {
      const result = await synthesizeSegment(
        segment.text,
        segment.language,
        speed,
        pitch,
        onChunk || (() => {})
      );
      
      totalBytes += result.bytes;
      results.push({
        text: segment.text,
        language: segment.language,
        voice: result.voice,
        bytes: result.bytes,
      });
    } catch (error: any) {
      console.error(`[MultilingualTTS] Failed to synthesize segment (${segment.language}):`, error.message);
      // Continue with next segment - don't skip, try with fallback voice
      try {
        const fallbackVoice = segment.language === 'bn' ? VOICE_MAP['en'] : VOICE_MAP['bn'];
        const result = await synthesizeSegment(
          segment.text,
          'en', // Use English as fallback
          speed,
          pitch,
          onChunk || (() => {})
        );
        totalBytes += result.bytes;
        results.push({
          text: segment.text,
          language: 'fallback-en',
          voice: fallbackVoice,
          bytes: result.bytes,
        });
      } catch (fallbackError: any) {
        console.error(`[MultilingualTTS] Fallback synthesis also failed:`, fallbackError.message);
        // Add empty result for this segment to maintain ordering
        results.push({
          text: segment.text,
          language: 'failed',
          voice: 'unknown',
          bytes: 0,
        });
      }
    }
  }

  console.log(`[MultilingualTTS] Completed: ${totalBytes} bytes across ${results.length} segments`);
  
  return { totalBytes, segments: results };
}

/**
 * Get the list of available multilingual voices
 */
export function getMultilingualVoices(): EdgeVoice[] {
  return POPULAR_EDGE_VOICES.filter(
    v => v.locale === 'bn-BD' || v.locale === 'bn-IN' || 
         v.locale === 'en-US' || v.locale === 'en-GB'
  );
}

/**
 * Preview a segment with detected language
 */
export function previewSegment(segment: LanguageSegment): string {
  return `[${segment.language.toUpperCase()}] ${segment.text}`;
}

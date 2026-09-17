import { synthesizeMultilingual, detectLanguage, splitIntoLanguageSegments } from './src/services/tts/multilingualTts';

async function testMultilingualTTS() {
  console.log('=== Automatic Multilingual TTS Test ===\n');
  
  // Test 1: Language Detection
  console.log('--- Test 1: Language Detection ---');
  const testTexts = [
    'আমার অর্ডার ট্র্যাক করুন',
    'Hello, how are you?',
    'আমার order status কত?',
    'API endpoint call করুন',
    'আমি ভালো আছি, ধন্যবাদ',
  ];
  
  for (const text of testTexts) {
    const lang = detectLanguage(text);
    console.log(`  "${text}" -> ${lang}`);
  }
  
  console.log('\n--- Test 2: Segment Splitting ---');
  const mixedText = 'আমার order tracking করতে চাই। API endpoint call করুন। আপনাকে ধন্যবাদ!';
  const segments = splitIntoLanguageSegments(mixedText);
  console.log(`Detected ${segments.length} segments:`);
  segments.forEach((seg, i) => {
    console.log(`  [${i + 1}] ${seg.language}: "${seg.text}"`);
  });
  
  console.log('\n--- Test 3: Multilingual Synthesis ---');
  const responseText = `আপনার অর্ডার #12345 এর status হচ্ছে Shipped। ETA ৩-৫ দিন। 

আপনি যাচাই করতে পারেন:
- Website: https://example.com/track
- API endpoint: POST /api/v1/orders/track

কোনো সাহায্য প্রয়োজন?`;
  
  const result = await synthesizeMultilingual(responseText, {
    speed: 1.0,
    pitch: 0,
    onChunk: (chunk, mimeType) => {
      console.log(`  [Streaming] Received ${chunk.length} bytes (${mimeType})`);
    },
  });
  
  console.log(`\nTotal segments processed: ${result.segments.length}`);
  console.log('Segment details:');
  result.segments.forEach((seg, i) => {
    console.log(`  [${i + 1}] ${seg.language.toUpperCase()} | Voice: ${seg.voice} | Bytes: ${seg.bytes}`);
  });
  console.log(`Total audio size: ${result.totalBytes} bytes`);
  
  console.log(`\n✅ Test completed successfully!`);
  console.log(`Total audio size: ${result.totalBytes} bytes`);
}

testMultilingualTTS().catch(console.error);

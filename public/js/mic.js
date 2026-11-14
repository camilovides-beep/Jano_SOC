// Microfono -> tramas PCM16 16 kHz. Usa la cancelacion de eco del navegador para que el avatar no se escuche a si mismo.
export async function startMic(ctx, onChunk) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  await ctx.audioWorklet.addModule(new URL('./mic-worklet.js', import.meta.url).href);
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'mic-processor', { numberOfInputs: 1, numberOfOutputs: 0 });
  node.port.onmessage = (ev) => onChunk(ev.data);
  source.connect(node);
  return { stop() { try { source.disconnect(); node.disconnect(); } catch {} stream.getTracks().forEach((t) => t.stop()); } };
}

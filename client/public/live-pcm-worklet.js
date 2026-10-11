class LivePcm extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = options.processorOptions?.targetSampleRate || 16000;
    this.frameSamples = Math.round(this.targetRate * ((options.processorOptions?.frameMs || 250) / 1000));
    this.step = sampleRate / this.targetRate;
    this.pendingInput = new Float32Array(0);
    this.position = 0;
    this.frame = new Float32Array(this.frameSamples);
    this.frameOffset = 0;
    this.sequence = 0;
    this.port.onmessage = ({ data }) => {
      if (data === 'flush') { this.stopped = true; this.emit(true); this.port.postMessage({ flushed: true }); }
    };
  }
  appendOutput(value) {
    this.frame[this.frameOffset++] = value;
    if (this.frameOffset === this.frame.length) this.emit(false);
  }
  emit(partial) {
    if (!this.frameOffset) return;
    const audio = partial ? this.frame.slice(0, this.frameOffset) : this.frame;
    this.port.postMessage({ audio, inputSampleRate: sampleRate, outputSampleRate: this.targetRate,
      frameMs: audio.length / this.targetRate * 1000, sequence: this.sequence++ }, [audio.buffer]);
    this.frame = new Float32Array(this.frameSamples); this.frameOffset = 0;
  }
  resample(samples) {
    const input = new Float32Array(this.pendingInput.length + samples.length);
    input.set(this.pendingInput); input.set(samples, this.pendingInput.length);
    while (this.position + 1 < input.length) {
      const left = Math.floor(this.position), fraction = this.position - left;
      this.appendOutput(input[left] + (input[left + 1] - input[left]) * fraction);
      this.position += this.step;
    }
    const consumed = Math.floor(this.position);
    this.pendingInput = input.slice(consumed); this.position -= consumed;
  }
  process(inputs) {
    if (this.stopped) return false;
    const samples = inputs[0]?.[0];
    if (samples?.length) this.resample(samples);
    return true;
  }
}
registerProcessor('live-pcm', LivePcm);

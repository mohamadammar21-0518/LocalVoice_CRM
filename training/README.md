# LocalVoice training workflow

There are two independent models: the Ollama model plans CRM actions; Whisper transcribes speech. TTS is unchanged. These tools prepare datasets and train candidate adapters; they do not upload data, start paid jobs, or replace a running model automatically.

## 1. Collect and review data

Open **CRM Studio → Training**. Add corrected commands with the current object schema and exact expected action (or a clarification). For speech, record a short voice request first, use its session ID, and enter exactly what was said. Use anonymous speaker IDs consistently. Confirm that you reviewed each label and have permission to train on the text/audio. Real customer data and identifiable voices need deliberate handling; fictional CRM examples are preferable.

Aim initially for several hundred diverse reviewed commands, including English, Malay, mixed-language phrases, missing fields, ambiguous names, unsupported requests and deletions that require clarification. This is a starting collection target, not a promised quality threshold. For speech, collect varied consenting speakers, microphones and noise conditions; use 0.3–30 second clips. At least three independent speaker groups are required by the splitter; more are needed for a representative test.

For a model intended specifically for **your own dictation**, record at least 50–100 short, corrected clips before considering a fine-tune. Use **Voice → Accurate (Whisper)** while collecting them: the low-latency English live dictation model is Vosk and is separate from Whisper, so a Whisper adapter does not change it. Give every distinct request its own scenario group and use one consistent speaker ID such as `my-voice`. For this narrowly scoped case, `--personal-voice` permits that one consented speaker in all splits; its test score measures only your voice, not general transcription quality.

Do not train from the existing tiny evaluation set. Keep it as a regression test. Corrections must be human-reviewed; successful API calls alone do not prove a transcript or action was correct.

## 2. Export locally

The browser exports a review manifest without audio. To produce trainable JSONL and copy only your approved local recordings:

```powershell
pnpm training:export USER_ID WORKSPACE_UUID training/data/export-001
python training/prepare.py command training/data/export-001/commands.jsonl training/data/commands-001
python training/prepare.py speech training/data/export-001/speech.jsonl training/data/speech-001
# Only for a one-person, consented dictation model:
python training/prepare.py speech training/data/export-001/speech.jsonl training/data/my-voice-001 --personal-voice
```

Run export from the project root with the existing database environment. Output must be empty. Review exports before moving them to another machine. The local-storage exporter cannot fetch recordings that exist only in S3. Removing an example in Training Lab prevents future exports; it does not delete past exports, existing models, or the original recording. Backups and retention still apply.

The splitter groups linked scenarios, identical command inputs, speakers and duplicate audio to prevent train/test leakage. It creates approximately 80/10/10 group splits and records a source hash. Highly connected data may leave too few independent groups; add diverse data instead of forcing a random row split.

## 3. Baseline first

```powershell
pnpm studio:evaluate training/data/commands-001/test.jsonl training/reports/command-base.json qwen2.5-coder:1.5b
# Load VOICE_SERVICE_TOKEN securely into the environment, not a shell argument.
python scripts/evaluate_speech.py training/data/speech-001/test.jsonl --url http://127.0.0.1:8001/transcribe --output training/reports/speech-base.json
```

Create `training/reports` first. Command evaluation invokes inference only: it never writes CRM records. It measures exact action matches, valid JSON/actions, unsafe actions when clarification was expected, and latency. Speech evaluation reports WER (including corpus WER per language), entity recall, errors and latency. Do not compare only training loss.

## 4. Train on a separate environment

The inspected workstation reports Intel Iris Xe graphics and no `nvidia-smi`. The included recipes target an NVIDIA CUDA training environment. Use a suitable GPU machine; select hardware after measuring the chosen model and sequence lengths. CPU training is explicitly opt-in for tiny smoke tests and can be impractically slow. No GPU rental is started by this project.

```bash
python -m venv .training-venv
# Activate it using your operating system's activation command.
pip install -r training/requirements.txt
python training/train_command.py training/data/commands-001 training/runs/command-001 --model Qwen/Qwen2.5-Coder-1.5B-Instruct
# The deployed private service currently uses `tiny`; keep the base checkpoint
# identical when you want to deploy an adapter directly. Choose `small` only if
# you also plan to switch the deployed service to a small CTranslate2 model.
python training/train_speech.py training/data/speech-001 training/runs/speech-001 --model openai/whisper-tiny
```

These are LoRA recipes using PEFT and Transformers. They train only on train and validation splits. They download the named base model on invocation, and write adapters locally. Their heavy GPU execution must be verified on your training machine; the development checks cover syntax, dataset logic, and the application integration, not a completed training job.

Use the exact base model corresponding to your deployed model. The Ollama tag alone does not prove checkpoint provenance: verify its metadata before importing a candidate. Pinned Python packages isolate this workflow from the working speech runtime. Install the appropriate CUDA PyTorch build if the default package is unsuitable for the training host.

## 5. Merge, convert and evaluate candidates

```bash
python training/merge_adapter.py command training/runs/command-001/adapter training/runs/command-001/merged
python training/merge_adapter.py speech training/runs/speech-001/adapter training/runs/speech-001/merged
```

For commands, convert the merged checkpoint to GGUF with a compatible llama.cpp version, then import it as a **new Ollama model name**. Ollama's direct Safetensors adapter import supports specific architectures; do not assume every Qwen adapter imports directly. Use a compatible model chat template and compare the same held-out test set with `pnpm studio:evaluate ... NEW_MODEL_NAME`.

For speech, install the CTranslate2 converter in the training environment and run:

```bash
ct2-transformers-converter --model training/runs/speech-001/merged --output_dir training/runs/speech-001/ct2 --copy_files tokenizer.json preprocessor_config.json --quantization int8
```

Start a separate Whisper service with `WHISPER_MODEL_SIZE` set to the absolute `ct2` directory and a different port, then run the same speech test manifest against it. The current Vosk live-English decoder is a separate model and is **not** changed by Whisper fine-tuning. Final Whisper transcription and Whisper-backed paths use the new model only after configuration changes.

Promote a candidate only if held-out command correctness improves, unsafe writes do not increase, English and Malay recognition remain acceptable, and latency stays usable. Keep old model names/directories for rollback. Fine-tuning does not bypass schema validation, record selection, permissions or confirmation.

## Primary references

- [PEFT quantization and adapter training](https://huggingface.co/docs/peft/main/en/developer_guides/quantization)
- [Whisper fine-tuning](https://huggingface.co/blog/fine-tune-whisper)
- [Ollama model import](https://docs.ollama.com/import)
- [faster-whisper model conversion](https://github.com/SYSTRAN/faster-whisper#model-conversion)

Training examples, exported audio, checkpoints and reports are Git-ignored. The recipes do not guarantee an improvement: the baseline/candidate comparisons determine whether an adapter is worth deploying.

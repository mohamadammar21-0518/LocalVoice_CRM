"""Fine-tune a multilingual Whisper adapter on reviewed English/Malay audio."""
import argparse
import json
from pathlib import Path


def main():
    p = argparse.ArgumentParser()
    p.add_argument("dataset")
    p.add_argument("output")
    p.add_argument("--model", default="openai/whisper-small")
    p.add_argument("--epochs", type=float, default=3)
    p.add_argument("--allow-cpu", action="store_true")
    args = p.parse_args()
    import torch
    import librosa
    from datasets import load_dataset
    from transformers import WhisperProcessor, WhisperForConditionalGeneration, Seq2SeqTrainer, Seq2SeqTrainingArguments
    from peft import LoraConfig, get_peft_model
    if not torch.cuda.is_available() and not args.allow_cpu:
        raise RuntimeError("CUDA GPU not detected. Use a GPU training machine, or --allow-cpu for a small smoke test.")
    out = Path(args.output)
    if out.exists() and any(out.iterdir()):
        raise ValueError("Output must be empty")
    processor = WhisperProcessor.from_pretrained(args.model)
    model = WhisperForConditionalGeneration.from_pretrained(args.model)
    model.config.use_cache = False
    data = load_dataset("json", data_files={s: str(Path(args.dataset) / f"{s}.jsonl") for s in ["train", "validation"]})
    def encode(row):
        audio, sr = librosa.load(row["audio"], sr=16000, mono=True)
        if not 0.3 <= len(audio) / sr <= 30:
            raise ValueError("Whisper training clips must be 0.3–30 seconds; segment and re-label longer recordings first")
        processor.tokenizer.set_prefix_tokens(language="malay" if row["language"] == "ms" else "english", task="transcribe")
        labels = processor.tokenizer(row["text"]).input_ids
        if len(labels) > 440:
            raise ValueError("Transcript too long; segment the clip")
        return {"input_features": processor.feature_extractor(audio, sampling_rate=sr).input_features[0], "labels": labels}
    encoded = data.map(encode, remove_columns=data["train"].column_names)
    def collate(rows):
        features = processor.feature_extractor.pad([{"input_features": r["input_features"]} for r in rows], return_tensors="pt")
        labels = processor.tokenizer.pad([{"input_ids": r["labels"]} for r in rows], return_tensors="pt")
        masked = labels["input_ids"].masked_fill(labels.attention_mask.ne(1), -100)
        if (masked[:, 0] == model.config.decoder_start_token_id).all().item():
            masked = masked[:, 1:]
        features["labels"] = masked
        return features
    # Generic PeftModel preserves Whisper's input_features forward signature.
    model = get_peft_model(model, LoraConfig(r=8, lora_alpha=16, target_modules=["q_proj", "v_proj"], lora_dropout=.05))
    config = Seq2SeqTrainingArguments(output_dir=str(out), per_device_train_batch_size=1, per_device_eval_batch_size=1, gradient_accumulation_steps=8, learning_rate=1e-4, num_train_epochs=args.epochs, eval_strategy="epoch", save_strategy="epoch", load_best_model_at_end=True, save_total_limit=2, remove_unused_columns=False, label_names=["labels"], report_to="none", seed=42, data_seed=42, logging_steps=10)
    trainer = Seq2SeqTrainer(model=model, args=config, train_dataset=encoded["train"], eval_dataset=encoded["validation"], data_collator=collate)
    trainer.train(); trainer.save_model(str(out / "adapter")); processor.save_pretrained(str(out / "adapter"))
    (out / "run.json").write_text(json.dumps({"baseModel": args.model, "dataset": str(Path(args.dataset).resolve()), "epochs": args.epochs, "testSetUsedForTraining": False, "validationLoss": trainer.evaluate()}, indent=2), encoding="utf-8")
    print("Whisper adapter saved. Merge and convert to CTranslate2, then compare held-out WER and name accuracy before deployment.")


if __name__ == "__main__":
    main()

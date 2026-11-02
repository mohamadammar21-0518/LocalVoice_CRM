"""Supervised LoRA training for Studio commands. No uploads or auto-deployment."""
import argparse
import json
from pathlib import Path


def main():
    p = argparse.ArgumentParser()
    p.add_argument("dataset", help="Directory produced by prepare.py command")
    p.add_argument("output")
    p.add_argument("--model", default="Qwen/Qwen2.5-Coder-1.5B-Instruct")
    p.add_argument("--epochs", type=float, default=3)
    p.add_argument("--max-length", type=int, default=2048)
    p.add_argument("--allow-cpu", action="store_true")
    args = p.parse_args()
    import torch
    from datasets import load_dataset
    from transformers import AutoTokenizer, AutoModelForCausalLM, Trainer, TrainingArguments
    from peft import LoraConfig, get_peft_model, TaskType
    if not torch.cuda.is_available() and not args.allow_cpu:
        raise RuntimeError("CUDA GPU not detected. Use a GPU training machine, or --allow-cpu for a small smoke test.")
    out = Path(args.output)
    if out.exists() and any(out.iterdir()):
        raise ValueError("Output must be empty")
    data = load_dataset("json", data_files={s: str(Path(args.dataset) / f"{s}.jsonl") for s in ["train", "validation"]})
    tokenizer = AutoTokenizer.from_pretrained(args.model, trust_remote_code=False)
    tokenizer.pad_token = tokenizer.eos_token
    def encode(row):
        prefix = tokenizer.apply_chat_template(row["prompt"], tokenize=True, add_generation_prompt=True)
        answer = tokenizer.encode(row["completion"][0]["content"], add_special_tokens=False) + [tokenizer.eos_token_id]
        ids = prefix + answer
        if len(ids) > args.max_length:
            raise ValueError("Training example exceeds max-length; shorten it instead of silently truncating its answer")
        return {"input_ids": ids, "attention_mask": [1] * len(ids), "labels": [-100] * len(prefix) + answer}
    encoded = data.map(encode, remove_columns=data["train"].column_names)
    def collate(rows):
        length = max(len(r["input_ids"]) for r in rows)
        return {key: torch.tensor([r[key] + [pad] * (length - len(r[key])) for r in rows]) for key, pad in [("input_ids", tokenizer.pad_token_id), ("attention_mask", 0), ("labels", -100)]}
    bf16 = torch.cuda.is_available() and torch.cuda.is_bf16_supported()
    model = AutoModelForCausalLM.from_pretrained(args.model, torch_dtype=torch.bfloat16 if bf16 else torch.float32, trust_remote_code=False)
    model = get_peft_model(model, LoraConfig(task_type=TaskType.CAUSAL_LM, r=16, lora_alpha=32, lora_dropout=.05, target_modules=["q_proj", "k_proj", "v_proj", "o_proj"]))
    model.config.use_cache = False
    config = TrainingArguments(output_dir=str(out), per_device_train_batch_size=1, per_device_eval_batch_size=1, gradient_accumulation_steps=8, learning_rate=2e-4, num_train_epochs=args.epochs, eval_strategy="epoch", save_strategy="epoch", load_best_model_at_end=True, save_total_limit=2, bf16=bf16, report_to="none", seed=42, data_seed=42, logging_steps=10)
    trainer = Trainer(model=model, args=config, train_dataset=encoded["train"], eval_dataset=encoded["validation"], data_collator=collate)
    trainer.train()
    trainer.save_model(str(out / "adapter")); tokenizer.save_pretrained(str(out / "adapter"))
    (out / "run.json").write_text(json.dumps({"baseModel": args.model, "dataset": str(Path(args.dataset).resolve()), "epochs": args.epochs, "testSetUsedForTraining": False, "metrics": trainer.evaluate()}, indent=2), encoding="utf-8")
    print("Adapter saved. Evaluate the held-out test set before merging or deployment.")


if __name__ == "__main__":
    main()

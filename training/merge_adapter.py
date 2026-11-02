"""Merge a trained adapter into its exact base checkpoint; never replace runtime models."""
import argparse
from pathlib import Path


def main():
    p = argparse.ArgumentParser()
    p.add_argument("task", choices=["command", "speech"])
    p.add_argument("adapter")
    p.add_argument("output")
    args = p.parse_args()
    from peft import PeftConfig, PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer, WhisperForConditionalGeneration, WhisperProcessor
    config = PeftConfig.from_pretrained(args.adapter)
    output = Path(args.output)
    if output.exists() and any(output.iterdir()):
        raise ValueError("Output must be empty")
    if args.task == "command":
        base = AutoModelForCausalLM.from_pretrained(config.base_model_name_or_path, trust_remote_code=False)
        processor = AutoTokenizer.from_pretrained(args.adapter, trust_remote_code=False)
    else:
        base = WhisperForConditionalGeneration.from_pretrained(config.base_model_name_or_path)
        processor = WhisperProcessor.from_pretrained(args.adapter)
    merged = PeftModel.from_pretrained(base, args.adapter).merge_and_unload()
    merged.save_pretrained(output, safe_serialization=True); processor.save_pretrained(output)
    print(f"Merged checkpoint saved to {output}. Existing runtime configuration was not changed.")


if __name__ == "__main__":
    main()

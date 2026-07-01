# Open-Source Local AI Models: State of the Art (May 2026)

*Research compiled 2026-05-25 for Derek's hardware: AMD Ryzen 7, 28 GB RAM, AMD Radeon 780M iGPU (4 GB VRAM), no dedicated GPU.*

---

## 1. Top General-Purpose Models (7B-14B Range)

| Model | Params | Active Params | Quantized Size (Q4) | Key Strengths | License | Released |
|-------|--------|---------------|---------------------|---------------|---------|----------|
| **Qwen 3 8B** | 8B dense | 8B | ~5 GB | Strong multilingual, coding, reasoning; thinking mode toggle | Apache 2.0 | Apr 2025 |
| **Qwen 3 14B** | 14B dense | 14B | ~9 GB | Best dense quality in its class; strong coding + math | Apache 2.0 | Apr 2025 |
| **Qwen 3 30B-A3B** | 30B MoE | 3B active | ~18 GB | MoE speed (only 3B fires per token); near-14B quality at 3x speed | Apache 2.0 | Apr 2025 |
| **Gemma 4 E4B** | ~4.5B effective | ~4.5B | ~3 GB | Vision + text natively; tool calling; ultra-efficient | Apache 2.0 | Apr 2026 |
| **Gemma 3 12B** | 12B dense | 12B | ~7.5 GB | Multimodal (image+text); 128K context; 140+ languages | Apache 2.0 | Mar 2025 |
| **Gemma 3 27B** | 27B dense | 27B | ~17 GB | Best open multimodal in its class; rich reasoning | Apache 2.0 | Mar 2025 |
| **Llama 3.3 8B** | 8B dense | 8B | ~5 GB | Most widely recommended starter model; great general-purpose | Llama 3.3 Community | Dec 2024 |
| **Llama 4 Scout** | 109B MoE | 17B active | ~24 GB (Q4) | 10M token context; multimodal; MoE efficiency | Llama 4 Community | Apr 2025 |
| **Phi-4** | 14B dense | 14B | ~9 GB | Best reasoning for its size; strong math/logic | MIT | Dec 2024 |
| **Phi-4 Mini** | 3.8B dense | 3.8B | ~2.5 GB | 128K context; native tool calling; great for edge | MIT | Feb 2025 |
| **Mistral 7B** | 7.3B dense | 7.3B | ~4.5 GB | Fast (40-60 tok/s); efficient; solid baseline | Apache 2.0 | Sep 2023 |
| **DeepSeek-V3** | 671B MoE | 37B active | Too large for this HW | Best open-source overall quality; 128K context | MIT | Dec 2024 |

### Notes for Your Hardware (28 GB RAM, 4 GB VRAM)
- **Sweet spot**: 7B-14B dense models at Q4 quantization (5-9 GB). These fit comfortably in RAM with room for OS and context.
- **Stretch**: Qwen 3 30B-A3B MoE at Q4 (~18 GB) is viable because only 3B activates per token, keeping inference fast despite the larger download.
- **Borderline**: Llama 4 Scout at Q4 (~24 GB) will load but leaves little headroom; expect slower inference. Q2 variant (~16 GB) is more practical.
- **Too large**: DeepSeek V3, Mistral Small 4 (119B MoE), Qwen 3.5 (122B MoE) -- all exceed your RAM even quantized.

---

## 2. Coding-Specific Models

| Model | Params | Quantized Size (Q4) | SWE-bench | Key Strengths | License |
|-------|--------|---------------------|-----------|---------------|---------|
| **Qwen 2.5 Coder 7B** | 7B | ~5 GB | -- | Top-rated local coding model; 16 GB RAM sufficient | Apache 2.0 |
| **Qwen 2.5 Coder 14B** | 14B | ~9 GB | -- | Best balance of quality and local-runability for code | Apache 2.0 |
| **Qwen 3.6 27B** | 27B | ~17 GB | 77.2% | New (May 2026); best dense coding model; strong agentic | Apache 2.0 |
| **DeepSeek Coder V2 16B** | 16B | ~10 GB | -- | Excellent Python/JS; MIT license | MIT |
| **Devstral Small 2** | 24B | ~15 GB | 68% | Strong SWE-bench; single-GPU friendly | Apache 2.0 |
| **StarCoder2 15B** | 15B | ~10 GB | -- | 600+ languages; 16K context; transparent training | OpenRAIL-M |
| **CodeGemma 7B** | 7B | ~5 GB | -- | Fill-in-the-middle; code completion; lightweight | Gemma license |
| **Codestral** | 22B | ~14 GB | -- | 600+ languages; strong generation | MNPL (restrictive) |

### Best for CPU Inference on Your Hardware
1. **Qwen 2.5 Coder 7B** -- Best coding quality at the 7B level, runs fast on CPU (~10-15 tok/s), only needs ~5 GB
2. **Qwen 2.5 Coder 14B** -- Step up in quality, ~9 GB Q4, still fits well in 28 GB RAM
3. **DeepSeek Coder V2 16B** -- Excellent for Python/JS, MIT license, ~10 GB Q4

### Frontier Coding Models (API-only at your hardware level)
- **DeepSeek V4-Pro** (1.6T/49B active, MIT) -- 80.6% SWE-bench, world's best coding model
- **Kimi K2.6** (42B active/1T MoE, MIT) -- 87/100 real-world coding
- **GLM-5.1** -- 77.8% SWE-bench Pro

---

## 3. Reasoning / Chain-of-Thought Models

| Model | Params | Quantized Size (Q4) | Key Benchmarks | Strengths | License |
|-------|--------|---------------------|----------------|-----------|---------|
| **DeepSeek-R1 Distill Qwen 7B** | 7B | ~5 GB | Strong on AIME, MATH-500 | Shows chain-of-thought reasoning; MIT; trained via knowledge distillation from full R1 | MIT |
| **DeepSeek-R1 Distill Llama 8B** | 8B | ~5 GB | Comparable to 7B Qwen variant | Llama-based; slightly different strengths | MIT |
| **DeepSeek-R1 Distill Qwen 14B** | 14B | ~9 GB | Near-competitive with much larger models | Best reasoning-per-GB at this tier; visible chain-of-thought | MIT |
| **DeepSeek-R1 Distill Qwen 32B** | 32B | ~20 GB | Close to full R1 quality | Fits in 28 GB RAM but tight; best quality reasoning you can run locally | MIT |
| **QwQ-32B** | 32B | ~20 GB | Strong AIME, MATH, CodeForces | Alibaba's pure-RL reasoning model; foundation for many derivatives | Apache 2.0 |
| **DeepSeek-R1 (full)** | 671B MoE | Too large | Matches OpenAI o1 | State-of-the-art open reasoning; requires server-grade hardware | MIT |

### What Makes These Special
- All R1 distills inherit the "thinking out loud" pattern from the full 671B model -- they show step-by-step reasoning in `<think>` tags before answering
- The 7B and 14B distills are the most practical for your hardware: full reasoning transparency at CPU-friendly sizes
- INT4 quantized versions recover 97%+ accuracy for 7B and larger models
- **Best pick for your hardware**: DeepSeek-R1 Distill Qwen 14B (Q4, ~9 GB) -- strong reasoning with visible chain-of-thought, fast enough on CPU

---

## 4. Multimodal Models (Vision + Text)

| Model | Params | Quantized Size (Q4) | Vision Capabilities | License |
|-------|--------|---------------------|---------------------|---------|
| **Gemma 4 9B** | 9B | ~6 GB | Image understanding + tool calling; best vision at this size | Apache 2.0 |
| **Gemma 4 E4B** | 4.5B eff. | ~3 GB | Vision on edge devices; audio input support | Apache 2.0 |
| **Gemma 3 12B** | 12B | ~7.5 GB | Image+text; 128K context; 140+ languages | Apache 2.0 |
| **Gemma 3 27B** | 27B | ~17 GB | Best multimodal you can run locally; image analysis | Apache 2.0 |
| **Llama 4 Scout** | 109B MoE (17B active) | ~24 GB | Natively multimodal; image understanding; 10M context | Llama 4 Community |
| **Qwen 2.5-VL 7B** | 7B | ~5 GB | Best balance for local vision deployment | Apache 2.0 |
| **LLaVA-NeXT 7B/13B** | 7B/13B | ~5/8 GB | End-to-end vision-language; widely supported | Apache 2.0 |
| **GLM-4.6V** | -- | -- | Native multimodal tool use; 128K context | Open |

### Best for Your Hardware
1. **Gemma 4 9B** -- Best vision quality that fits comfortably (6 GB Q4); tool calling built in
2. **Qwen 2.5-VL 7B** -- Lighter option at 5 GB; good image understanding
3. **Gemma 3 12B** -- Step up in quality if you need stronger image analysis

---

## 5. Inference Runtimes for Windows + AMD

### Runtime Comparison

| Runtime | AMD iGPU Support | Setup Difficulty | Best For |
|---------|-----------------|------------------|----------|
| **Ollama** | Vulkan (experimental, set `OLLAMA_VULKAN=1`) | Easy (one installer) | Beginners, CLI users, API serving |
| **LM Studio** | ROCm (community hack for 780M via manual lib replacement) | Medium | GUI users, model browsing, chat UI |
| **llama.cpp** | Vulkan backend (best AMD iGPU support) | Medium-Hard | Power users, maximum performance |
| **GPT4All** | Vulkan (cross-platform) | Easy | Beginners, document chat, privacy-first |
| **Jan.ai** | Vulkan (via backend config) | Easy | ChatGPT-like desktop UI, VS Code integration |
| **vLLM** | ROCm (Linux only for AMD) | Hard | Server deployments (not recommended for iGPU) |

### AMD Radeon 780M Specifics

**The reality**: ROCm does NOT support Windows APUs. Vulkan is your only path to GPU acceleration on Windows with the 780M.

**Setup for Ollama (recommended)**:
1. Install Ollama from ollama.com
2. Set system environment variable: `OLLAMA_VULKAN=1` (Windows Settings > System > Environment Variables)
3. Ensure AMD GPU drivers are up to date (2025.11+ recommended; 2024.12 has known issues)
4. Restart Ollama service
5. Test: `ollama run gemma3:4b` -- should show GPU layers being offloaded

**Expected Performance with Vulkan on 780M**:
- 7B models: ~8-15 tokens/sec (generation)
- 4B models: ~15-25 tokens/sec
- CPU-only fallback: ~5-10 tok/s for 7B, ~2-5 tok/s for 14B

**Important Notes**:
- Vulkan acceleration on the 780M won't match discrete GPUs, but it's a meaningful speedup over pure CPU (roughly 2-3x)
- AMD's Vulkan driver on Linux is faster than Windows for compute workloads
- Ollama's vendored llama.cpp currently has a ~56% throughput gap vs standalone llama.cpp for Vulkan (upstream patches not yet integrated)
- Increasing GTT size in BIOS (if supported) can help with larger models on iGPU

### Recommendation
**Start with Ollama** (simplest setup, Vulkan support, huge model library). If you want a GUI, add **LM Studio** or **Jan.ai** alongside. If you want maximum throughput from the 780M, compile **llama.cpp from source** with Vulkan backend.

---

## 6. What's New (March-May 2026)

### Major Releases

| Date | Model | Significance |
|------|-------|-------------|
| **Mar 16, 2026** | **Mistral Small 4** (119B MoE, 4 active) | Apache 2.0; runs like a 6-8B model despite 119B total |
| **Apr 2, 2026** | **Gemma 4** (E2B, E4B, 26B MoE, 31B Dense) | Google's best open model; Apache 2.0; vision + tool calling; E4B runs on 8 GB laptops |
| **Apr 2026** | **DeepSeek V4-Pro** (1.6T/49B active) | 80.6% SWE-bench; world's best coding model; MIT; 1M context |
| **Apr 29, 2026** | **Mistral Medium 3.5** (128B dense) | 77.6% SWE-bench; dense architecture |
| **May 2026** | **Qwen 3.6 27B** | 77.2% SWE-bench; best dense coding model for local use |
| **May 2026** | **Qwen 3.6 35B-A3B** | MoE variant; only 3B active; fast inference |
| **May 2026** | **Kimi K2.6** (42B active / 1T MoE) | MIT license; 87/100 real-world coding; first non-Western model at Tier A coding |
| **May 2026** | **GLM-5.1** | 77.8% SWE-bench Pro; structured code generation leader |

### Key Trends

1. **MoE dominance**: Nearly every major release uses Mixture-of-Experts. This is a massive win for local inference -- 100B+ total parameter models that only activate 3-17B per token, running on consumer hardware.

2. **Agent-first design**: Every May 2026 release emphasizes tool calling, multi-step planning, and error recovery. Agent reliability is now the primary differentiator between models.

3. **Apache 2.0 everywhere**: Gemma 4, Qwen 3/3.5/3.6, Mistral Small 4, Devstral Small 2 -- the most commercially permissive license is now the default for frontier open models.

4. **Vulkan acceleration maturing**: Ollama's experimental Vulkan support is becoming the standard path for AMD GPU users on Windows. Not yet as polished as CUDA, but functional and improving.

5. **Five frontier-class open-weight models shipped in the last 30 days**: Llama 4, Qwen 3.5, DeepSeek V4, Gemma 4, and Mistral Medium 3.5. The gap between open-source and proprietary models continues to narrow.

6. **Coding models surging**: Open-source coding models now routinely score 68-80%+ on SWE-bench Verified, territory that was GPT-4-class a year ago.

---

## 7. Practical Recommendations for Your Hardware

**Your setup**: AMD Ryzen 7, 28 GB RAM, Radeon 780M (4 GB VRAM), Windows 11, no dedicated GPU.

**Constraints**: 
- ~24 GB usable for model loading (after OS/apps)
- 4 GB VRAM for Vulkan offload (helps but won't transform performance)
- CPU is the primary compute path; Vulkan is a bonus

### Top 3 Models to Install First

#### 1. Qwen 3 8B (Q4_K_M) -- Your Daily Driver
- **Size**: ~5 GB
- **Why**: Best overall quality at the 8B tier. Supports "thinking mode" toggle for reasoning tasks. Strong coding, math, and multilingual. Apache 2.0. Fast on CPU (~10-15 tok/s) with Vulkan boost.
- **Install**: `ollama pull qwen3:8b`
- **Use for**: General questions, writing, coding help, analysis, daily tasks

#### 2. DeepSeek-R1 Distill Qwen 14B (Q4_K_M) -- Your Reasoning Engine
- **Size**: ~9 GB
- **Why**: Visible chain-of-thought reasoning inherited from the 671B parent. Shows its work in `<think>` tags. Best reasoning-per-compute at this size. MIT license. 97%+ accuracy retained at INT4.
- **Install**: `ollama pull deepseek-r1:14b`
- **Use for**: Complex problems, math, logic, debugging code, strategic analysis, anything where you want to see the model's reasoning process

#### 3. Gemma 4 9B (Q4_K_M) -- Your Vision + Tool Model
- **Size**: ~6 GB
- **Why**: Google's latest (April 2026). Native vision (describe images, read screenshots, analyze charts). Built-in tool calling. Apache 2.0. Runs at ~8-12 tok/s with Vulkan. Only 6 GB means you can run it alongside another model.
- **Install**: `ollama pull gemma4:9b`
- **Use for**: Image analysis, multimodal tasks, tool-calling workflows, anything visual

### Bonus: Stretch Picks
- **Qwen 2.5 Coder 14B** (~9 GB) if you do heavy coding -- purpose-built for code generation
- **Qwen 3 30B-A3B** (~18 GB MoE) if you want near-frontier quality -- only 3B activates per token so it's surprisingly fast despite the size
- **Llama 4 Scout Q2** (~16 GB) if you need massive context (10M tokens) -- the MoE architecture means only 17B activates

### Setup Checklist

1. Install Ollama: https://ollama.com/download
2. Set environment variable: `OLLAMA_VULKAN=1` (system-wide)
3. Update AMD GPU drivers to 2025.11+
4. Pull your first model: `ollama pull qwen3:8b`
5. Test: `ollama run qwen3:8b "Hello, what can you do?"`
6. For GUI: Install LM Studio or Jan.ai alongside Ollama
7. For API access: Ollama serves OpenAI-compatible API at `http://localhost:11434`

---

## Sources

- [Best Open-Source LLMs (HuggingFace Blog)](https://huggingface.co/blog/daya-shankar/open-source-llms)
- [Open Source LLM Comparison Table (ComputingForGeeks)](https://computingforgeeks.com/open-source-llm-comparison/)
- [Top Local LLM Tools and Models (Pinggy)](https://pinggy.io/blog/top_5_local_llm_tools_and_models/)
- [Best Open Source LLMs to Run Locally (HuggingFace)](https://huggingface.co/blog/daya-shankar/open-source-llm-models-to-run-locally)
- [Best Open Source LLMs for Coding (Pinggy)](https://pinggy.io/blog/best_open_source_self_hosted_llms_for_coding/)
- [Best Coding Models Comparison (AIMadeTools)](https://www.aimadetools.com/blog/best-open-source-coding-model-2026/)
- [Top 10 Open-Source Reasoning Models (Clarifai)](https://www.clarifai.com/blog/top-10-open-source-reasoning-models-in-2026)
- [DeepSeek R1 (LM Studio Blog)](https://lmstudio.ai/blog/deepseek-r1)
- [Ollama Hardware Support](https://docs.ollama.com/gpu)
- [AMD GPU Vulkan Ollama Setup (BinWH)](https://www.binwh.com/en/2026/04/12/vulkan-ollama-amd-gpu/)
- [Ollama AMD 780M (Medium)](https://medium.com/@neil.wu.mk/run-ollama-on-windows-11-with-amd-radean-780m-7a717c0cf2de)
- [Gemma 4 Guide (AurigaIT)](https://aurigait.com/blog/gemma-4-features-benchmarks-guide/)
- [Gemma 4 Official (Google Blog)](https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/)
- [Qwen 3.6 Local Guide (CoderSera)](https://codersera.com/blog/how-to-run-qwen-3-6-locally-2026/)
- [Qwen 3 Hardware Guide (Compute Market)](https://www.compute-market.com/blog/qwen-3-local-hardware-guide-2026)
- [Phi-4 Review (TokenMix)](https://tokenmix.ai/blog/phi-4-review-microsoft-small-model-2026)
- [New LLM Releases April 2026 (Fazm)](https://fazm.ai/blog/new-llm-releases-april-2026)
- [LLM News May 2026 (LLM-Stats)](https://llm-stats.com/ai-news)
- [New Ollama Models May 2026 (PromptQuorum)](https://www.promptquorum.com/local-llms/top-open-source-models-ollama)
- [Multimodal Vision Language Models (BentoML)](https://www.bentoml.com/blog/multimodal-ai-a-guide-to-open-source-vision-language-models)
- [Llama 4 Scout Local (MashBlog)](https://mashblog.com/posts/llama-4-scout)
- [LM Studio vs Jan vs GPT4All (ToolHalla)](https://toolhalla.ai/blog/lm-studio-vs-jan-vs-gpt4all-2026)
- [Local LLM Hardware Guide 2026 (PromptQuorum)](https://www.promptquorum.com/local-llms/local-llm-hardware-guide-2026)
- [llama.cpp Vulkan Performance Discussion](https://github.com/ggml-org/llama.cpp/discussions/10879)
- [llama.cpp GPU Benchmark Scoreboard (KnightLi)](https://knightli.com/en/2026/04/23/llama-cpp-gpu-benchmark-cuda-rocm-vulkan-scoreboard/)

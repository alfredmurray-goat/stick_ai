// Runs llama.cpp's own clip encoder on 8-bit RGB pixels (already sized to whole merged patches) and
// writes the projected embeddings without the [IMG_BREAK] rows, for comparison with `stellan-run see`.
// Not part of the build. With llama.cpp at the pinned commit, configured with -DLLAMA_BUILD_MTMD=ON:
//   cmake --build build --target mtmd
//   g++ -std=c++17 -O2 eye-parity.cpp -Itools/mtmd -Iinclude -Iggml/include -Icommon -Ivendor \
//     build/tools/mtmd/libmtmd.a build/src/libllama.a build/ggml/src/libggml.a \
//     build/ggml/src/libggml-cpu.a build/ggml/src/libggml-base.a -fopenmp -lpthread -ldl -o eye-parity
//   ./eye-parity MMPROJ RGB WIDTH HEIGHT THREADS OUT.f32
// Older Mistral Small 3.1 mmproj files say clip.use_gelu; Mistral corrected the encoder to SiLU on
// 9 May 2025. Rename that key to clip.use_silu (same length) in a copy so both engines run SiLU.
#include "clip.h"
#include "clip-impl.h"
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <vector>

int main(int argc, char **argv) {
    if (argc != 7) { std::fprintf(stderr, "eye-parity MMPROJ RGB WIDTH HEIGHT THREADS OUT\n"); return 2; }
    const int w = std::atoi(argv[3]), h = std::atoi(argv[4]), threads = std::atoi(argv[5]);
    clip_context_params params {};
    params.use_gpu = false; params.flash_attn_type = CLIP_FLASH_ATTN_TYPE_DISABLED;
    params.image_min_tokens = -1; params.image_max_tokens = -1; params.warmup = false;
    auto init = clip_init(argv[1], params);
    if (!init.ctx_v) { return 1; }
    std::ifstream in(argv[2], std::ios::binary);
    std::vector<unsigned char> rgb((std::istreambuf_iterator<char>(in)), {});
    clip_image_u8 u8; u8.set_size({w, h}, false); u8.cpy_buf(rgb);
    clip_image_f32 img; img.from_u8(u8);
    const float mean[3] = {0.48145466f, 0.4578275f, 0.40821073f}, deviation[3] = {0.26862954f, 0.26130258f, 0.27577711f};
    img.normalize(mean, deviation);
    const int n = clip_n_output_tokens(init.ctx_v, &img), d = clip_n_mmproj_embd(init.ctx_v);
    std::vector<float> out((size_t) n * d);
    const auto start = std::chrono::steady_clock::now();
    if (!clip_image_encode(init.ctx_v, threads, &img, out)) { return 1; }
    const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
    const int columns = w / 28, rows = h / 28;
    std::ofstream file(argv[6], std::ios::binary);
    for (int r = 0; r < rows; ++r) { file.write((const char *) (out.data() + (size_t) r * (columns + 1) * d), (std::streamsize) columns * d * sizeof(float)); }
    std::printf("{\"tokens_with_breaks\":%d,\"width\":%d,\"encode_ms\":%.1f}\n", n, d, ms);
}

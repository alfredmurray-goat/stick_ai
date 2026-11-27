#pragma once
namespace stellan::hooks {
/** stellan-host --hook-config: hookConfig from src/portable/hooks.ts. */
int hook_config();
/** stellan-host --run-hook ROOTS: runs one hook and prints its reply; closing stdin cancels it. */
int run_hook(int argc, char **argv);
}

#pragma once
namespace stellan {
/** Native supervisor for one MCP program: own process group, direct stdio, lifeline on fd 3. */
int mcp_bridge(int argc, char **argv);
}

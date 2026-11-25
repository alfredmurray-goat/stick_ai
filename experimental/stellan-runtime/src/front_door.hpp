#pragma once
namespace stellan {
/** Native app front door: serves the window and forwards API requests to the Node backend while routes move to Host. */
int front_door(int argc, char **argv);
}

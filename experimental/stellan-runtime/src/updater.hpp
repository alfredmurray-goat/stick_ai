#pragma once
namespace stellan::updater {
/**
 * stellan-host --update --root ROOT (--check | --prepare --parent PID | --apply --work DIR --parent PID --temporary DIR)
 * The app updater (src/portable/update-entry.ts and update.ts) in Host: same arguments, same JSON on stdout, same
 * checks, so the desktop shell can update a stick without Node.
 */
int main(int argc, char **argv);
}

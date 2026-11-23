# Context and chat memory


The sidebar shows a context wheel and the **Long context** switch. Normal is the lower-RAM default: Lite's window is 65,536 tokens and Max's is 8,192. Long raises Lite to 262,144 and Max to 16,384 / 32,768 / 65,536 according to the computer's memory. More tokens can mean slower replies; a bigger window does not change the model's reasoning weights. The wheel uses the latest token usage reported by the local inference server. If usage has not been reported, it shows an unavailable marker rather than an estimated percentage.

Chat memory is also in the sidebar. Each chat saves local `logs/chats/<project-id>/<chat-id>.md` notes and a bounded JSON snapshot. It keeps the most recent eight turn summaries, with clipped task/answer excerpts; this is not a full transcript or lossless infinite context. Up to 8 KB of notes are recalled when resuming that chat after a restart, in the task message, without rewriting the cached system prompt. Notes are untrusted and assistant statements may be wrong. No extra model call or training run is used to write them.

**New conversation** starts a separate memory file and preserves previous chats' files. Projects have isolated note folders. Expand **Chat memory** to view notes, disable saving or forget the current chat's saved notes. Disabling keeps existing files until forgotten; forgetting notes does not delete the open in-memory conversation. Notes remain on the stick, use private file permissions and are not automatically sent for training. User-enabled hooks/tools keep their existing behavior and approvals.

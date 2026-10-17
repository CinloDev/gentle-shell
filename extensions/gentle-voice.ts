import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerVoiceCommand, type VoiceCommandDeps } from "../lib/voice-command.ts";

// Gentle Voice: /gentle:voice owns optional local dictation (docs/voice.md).
// Loading this extension only registers the command; nothing is probed,
// downloaded, loaded or recorded until the user runs it.

export default function gentleVoice(pi: ExtensionAPI, deps: VoiceCommandDeps = {}): void {
	registerVoiceCommand(pi, deps);
}

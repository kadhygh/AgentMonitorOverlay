# DXX Codex CLI

AMO Models settings supports a separate DXX API key, stored in Windows Credential Manager. Select **DXX · GPT-5.6 Sol** when launching Codex CLI. The preset uses `gpt-5.6-sol`, provider `amo-dxx`, Responses API, and the exact base URL `https://gorilla-api.dxxapi.com` (no automatic `/v1` suffix).

The key is passed through `DXX_API_KEY` for that CLI process and removed from its terminal environment on exit. AMO does not write the key or provider into the shared Codex config/auth files. Managed resume uses the session’s recorded DXX preset and its saved key; save the key in Models settings to resume without re-entering it.

The model catalog uses Sol capability metadata from the OpenCodex upstream snapshot (b0900e556e50984a651a4c72db000e9285a6952a), with AMO’s existing coding instructions. Actual gateway support must be confirmed with a live request. This preset does not change Codex App or the existing Codex default preset, which still inherits local configuration.

@echo off
rem Opens a project's changes in the running AMO Studio's Git Review window. Options: see scripts\amo-review.mjs.
node "%~dp0scripts\amo-review.mjs" %*

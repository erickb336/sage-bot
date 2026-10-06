# The pinned sage state tool

`39e9bf767a1f/sage.mjs` is a copy of the sage state tool from the sage plugin, version `39e9bf767a1f` (the plugin cache folder `sage/sage/39e9bf767a1f/skills/sage/sage.mjs`), from the sage kit, <https://github.com/erickb336/sage>, MIT licence. SHA-256: `99bcd2e1a71d66c053745b4e55463c54d34ccd84408f8ef382e7452404dc4b72`. It imports only Node built-in modules.

The tests run this copy (`test/bridge-setup.js`, `SAGE`), so that no test reads or depends on the sage plugin in the owner's home folder. To test against another version of sage, set `SAGE_TOOL` to a copy of it outside `~/.claude`. To update the pin, add a new version folder, point `FIXTURE` in `test/bridge-setup.js` at it, and delete the old folder.

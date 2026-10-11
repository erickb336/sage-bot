# The pinned sage state tool

`6ea307ffa7b5/skills/sage/sage.mjs` is a copy of the sage state tool from the sage plugin, version `6ea307ffa7b5` (the plugin cache folder `sage/sage/6ea307ffa7b5/`), from the sage kit, <https://github.com/erickb336/sage>, MIT licence (`6ea307ffa7b5/LICENSE`). The tool imports the plugin's `core/` folder, so the version folder holds `skills/sage/sage.mjs` and `core/` as the plugin has them. Together they import only Node built-in modules. The hash is of the version folder (each file's path and content, in path order, as `test/t162-sage-fixture.test.js` computes it). SHA-256: `4bedb243103b8e9f4ac7c354e8217a7b6e9baa606bd798e79f4a8fd32aa64b63`.

The tests run this copy (`test/bridge-setup.js`, `SAGE`), so that no test reads or depends on the sage plugin in the owner's home folder. To test against another version of sage, set `SAGE_TOOL` to a copy of it outside `~/.claude`. To update the pin, add a new version folder with its `skills/sage/sage.mjs`, `core/` and `LICENSE`, point `FIXTURE` in `test/bridge-setup.js` at it, put its hash here (the T162 test prints it), and delete the old folder.

Since version `6ea307ffa7b5`, `gate answer <G>` takes `--option <n>` (the number of an option) or `--other-hex <hex>` (the owner's own words), never answer text. The bridge (`src/sage.js`, `answerArgs`) and the demo use that form.

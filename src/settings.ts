import { Notice, App, PluginSettingTab, Setting } from "obsidian";

import D2Plugin from "./main";
import { LAYOUT_ENGINES } from "./constants";

export interface D2PluginSettings {
  layoutEngine: string;
  apiToken: string;
  debounce: number;
  theme: number;
  d2Path: string;
  pad: number;
  sketch: boolean;
  containerHeight: number;
  transparentBackground: boolean;
  // Per engine, because the two expose different flags with different defaults
  // and no shared unit — one number for both would silently mean two things.
  elkNodeSeparation: number;
  dagreNodeSeparation: number;
  dagreRankSeparation: number;
}

export const DEFAULT_SETTINGS: D2PluginSettings = {
  layoutEngine: "dagre",
  debounce: 500,
  theme: 0,
  apiToken: "",
  d2Path: "",
  pad: 100,
  sketch: false,
  containerHeight: 800,
  // Off by default: the themed canvas is what d2 renders standalone, and a note
  // with a different background is the reason to change it, not the norm.
  transparentBackground: false,
  // d2's own defaults, so an untouched install renders exactly as it does today.
  elkNodeSeparation: 70,
  dagreNodeSeparation: 60,
  // Zero means let d2 derive it, and at zero the flag is not sent at all —
  // stock d2 rejects it as unknown, so an untouched install must keep working
  // against any build. Setting a value is the opt-in.
  dagreRankSeparation: 0,
};

export class D2SettingsTab extends PluginSettingTab {
  plugin: D2Plugin;
  talaSettings: HTMLDivElement;

  constructor(app: App, plugin: D2Plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  addTALASettings() {
    const talaSettings = this.containerEl.createEl("div");
    talaSettings.createEl("h3", {
      text: "TALA settings",
    });
    new Setting(talaSettings)
      .setName("API token")
      .setDesc(
        'To use TALA, copy your API token here or in ~/.local/state/tstruct/auth.json under the field "api_token"'
      )
      .addText((text) =>
        text
          .setPlaceholder("tstruct_...")
          .setValue(this.plugin.settings.apiToken)
          .setDisabled(this.plugin.settings.layoutEngine !== LAYOUT_ENGINES.TALA.value)
          .onChange(async (value) => {
            if (value && !value.startsWith("tstruct_")) {
              new Notice("Invalid API token");
            } else {
              this.plugin.settings.apiToken = value;
              await this.plugin.saveSettings();
            }
          })
      );

    this.talaSettings = talaSettings;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h1", { text: "D2 plugin settings" });

    new Setting(containerEl)
      .setName("Layout engine")
      .setDesc(
        'Available layout engines include "dagre", "ELK", and "TALA" (TALA must be installed separately from D2)'
      )
      .addDropdown((dropdown) => {
        dropdown
          .addOption(LAYOUT_ENGINES.DAGRE.value, LAYOUT_ENGINES.DAGRE.label)
          .addOption(LAYOUT_ENGINES.ELK.value, LAYOUT_ENGINES.ELK.label)
          .addOption(LAYOUT_ENGINES.TALA.value, LAYOUT_ENGINES.TALA.label)
          .setValue(this.plugin.settings.layoutEngine)
          .onChange(async (value) => {
            this.plugin.settings.layoutEngine = value;
            await this.plugin.saveSettings();
            // Redraw the whole tab: the spacing control belongs to the engine,
            // so which one is shown changes with this dropdown.
            this.display();
          });
      });

    new Setting(containerEl)
      .setName("Theme ID")
      .setDesc(
        "Available themes are located at https://github.com/d2lang/d2/tree/master/d2themes"
      )
      .addText((text) =>
        text
          .setPlaceholder("Enter a theme ID")
          .setValue(String(this.plugin.settings.theme))
          .onChange(async (value) => {
            if (!isNaN(Number(value)) || value === "") {
              this.plugin.settings.theme = Number(value || DEFAULT_SETTINGS.theme);
              await this.plugin.saveSettings();
            } else {
              new Notice("Please specify a valid number");
            }
          })
      );

    new Setting(containerEl)
      .setName("Pad")
      .setDesc("Pixels padded around the rendered diagram")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.pad))
          .setValue(String(this.plugin.settings.pad))
          .onChange(async (value) => {
            if (isNaN(Number(value))) {
              new Notice("Please specify a valid number");
              this.plugin.settings.pad = Number(DEFAULT_SETTINGS.pad);
            } else if (value === "") {
              this.plugin.settings.pad = Number(DEFAULT_SETTINGS.pad);
            } else {
              this.plugin.settings.pad = Number(value);
            }
            await this.plugin.saveSettings();
          })
      );

    // Spacing is a per-engine flag: elk and dagre name it differently and start
    // from different defaults, so they get separate values. TALA exposes none.
    const engine = this.plugin.settings.layoutEngine;
    const isElk = engine === LAYOUT_ENGINES.ELK.value;
    if (isElk || engine === LAYOUT_ENGINES.DAGRE.value) {
      const fallback = isElk
        ? DEFAULT_SETTINGS.elkNodeSeparation
        : DEFAULT_SETTINGS.dagreNodeSeparation;
      new Setting(containerEl)
        .setName("Node separation")
        // The two engines tune OPPOSITE axes, which decides which one to pick
        // for a given diagram — so each description says which way it squeezes
        // rather than repeating the upstream wording.
        .setDesc(
          isElk
            ? `Pixels between adjacent layers. Squeezes ALONG the layout direction, so it narrows a "right" diagram and shortens a "down" one (ELK, default ${fallback})`
            : `Pixels between nodes within a layer. Squeezes ACROSS the layout direction, so it shortens a "right" diagram and narrows a "down" one (dagre, default ${fallback})`
        )
        .addText((text) =>
          text
            .setPlaceholder(String(fallback))
            .setValue(
              String(
                isElk
                  ? this.plugin.settings.elkNodeSeparation
                  : this.plugin.settings.dagreNodeSeparation
              )
            )
            .onChange(async (value) => {
              let next = Number(value);
              if (value === "") {
                next = fallback;
              } else if (isNaN(next) || next < 0) {
                new Notice("Please specify a positive number");
                next = fallback;
              }
              if (isElk) {
                this.plugin.settings.elkNodeSeparation = next;
              } else {
                this.plugin.settings.dagreNodeSeparation = next;
              }
              await this.plugin.saveSettings();
            })
        );
    }

    if (engine === LAYOUT_ENGINES.DAGRE.value) {
      new Setting(containerEl)
        .setName("Rank separation")
        .setDesc(
          `Pixels between ranks — the axis "Node separation" cannot reach. 0 lets d2 derive it from the widest edge label, which sizes every gap in the diagram for its longest label. A set value overrides that and is usually far smaller; check no label ends up over a node. Needs a d2 build accepting --dagre-ranksep, and at 0 nothing is sent so any d2 works.`
        )
        .addText((text) =>
          text
            .setPlaceholder(String(DEFAULT_SETTINGS.dagreRankSeparation))
            .setValue(String(this.plugin.settings.dagreRankSeparation))
            .onChange(async (value) => {
              let next = Number(value);
              if (value === "") {
                next = DEFAULT_SETTINGS.dagreRankSeparation;
              } else if (isNaN(next) || next < 0) {
                new Notice("Please specify a positive number");
                next = DEFAULT_SETTINGS.dagreRankSeparation;
              }
              this.plugin.settings.dagreRankSeparation = next;
              await this.plugin.saveSettings();
            })
        );
    }

    new Setting(containerEl)
      .setName("Sketch mode")
      .setDesc("Render the diagram to look like it was sketched by hand")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.sketch).onChange(async (value) => {
          this.plugin.settings.sketch = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Transparent background")
      .setDesc(
        "Drop the diagram's own canvas so the note's background shows through"
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.transparentBackground)
          .onChange(async (value) => {
            this.plugin.settings.transparentBackground = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Container height")
      .setDesc("Diagram max render height in pixels (Requires d2 v0.2.2 and up)")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.containerHeight))
          .setValue(String(this.plugin.settings.containerHeight))
          .onChange(async (value) => {
            if (isNaN(Number(value))) {
              new Notice("Please specify a valid number");
              this.plugin.settings.containerHeight = Number(
                DEFAULT_SETTINGS.containerHeight
              );
            } else if (value === "") {
              this.plugin.settings.containerHeight = Number(
                DEFAULT_SETTINGS.containerHeight
              );
            } else {
              this.plugin.settings.containerHeight = Number(value);
            }
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Debounce")
      .setDesc("How often should the diagram refresh in milliseconds (min 100)")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.debounce))
          .setValue(String(this.plugin.settings.debounce))
          .onChange(async (value) => {
            if (isNaN(Number(value))) {
              new Notice("Please specify a valid number");
              this.plugin.settings.debounce = Number(DEFAULT_SETTINGS.debounce);
            } else if (value === "") {
              this.plugin.settings.debounce = Number(DEFAULT_SETTINGS.debounce);
            } else if (Number(value) < 100) {
              new Notice("The value must be greater than 100");
              this.plugin.settings.debounce = Number(DEFAULT_SETTINGS.debounce);
            } else {
              this.plugin.settings.debounce = Number(value);
            }
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Path (optional)")
      .setDesc(
        "Customize the local path to the directory `d2` is installed in (ex. if d2 is located at `/usr/local/bin/d2`, then the path is `/usr/local/bin`). This is only necessary if `d2` is not found automatically by the plugin (but is installed)."
      )
      .addText((text) => {
        text
          .setPlaceholder("/usr/local/Cellar")
          .setValue(this.plugin.settings.d2Path)
          .onChange(async (value) => {
            this.plugin.settings.d2Path = value;
            await this.plugin.saveSettings();
          });
      });

    if (this.plugin.settings.layoutEngine === LAYOUT_ENGINES.TALA.value) {
      this.addTALASettings();
    }
  }
}

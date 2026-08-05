import { MarkdownPostProcessorContext, ButtonComponent } from "obsidian";
import { exec, execSync } from "child_process";
import { delimiter } from "path";
import debounce from "lodash.debounce";
import os from "os";

import D2Plugin from "./main";

export class D2Processor {
  plugin: D2Plugin;
  debouncedMap: Map<
    string,
    (
      source: string,
      el: HTMLElement,
      ctx: MarkdownPostProcessorContext,
      signal?: AbortSignal
    ) => Promise<void>
  >;
  abortControllerMap: Map<string, AbortController>;
  actualSizeMap: Map<string, boolean>;
  prevImage: string;
  abortController: AbortController;

  constructor(plugin: D2Plugin) {
    this.plugin = plugin;
    this.debouncedMap = new Map();
    this.abortControllerMap = new Map();
    this.actualSizeMap = new Map();
  }

  attemptExport = async (
    source: string,
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext
  ) => {
    el.createEl("h6", {
      text: "Generating D2 diagram...",
      cls: "D2__Loading",
    });

    // we need to generate a debounce per split page, and ctx.containerEl is the only element we have access to that's page specific
    // however, it is not publically available in MarkdownPostProcessorContext, so we hack its access by casting it to an 'any' type
    const pageContainer = (ctx as any).containerEl;
    let pageID = pageContainer.dataset.pageID;
    if (!pageID) {
      pageID = Math.floor(Math.random() * Date.now()).toString();
      pageContainer.dataset.pageID = pageID;
    }

    // Key per DIAGRAM, not per page. A page-wide debounce and abort controller
    // meant a second d2 block cancelled the first block's in-flight render,
    // surfacing as "D2 Compilation Error: The operation was aborted" on
    // whichever diagram was slow enough to lose the race — so it looked
    // intermittent and content-dependent. lineStart identifies the block within
    // the file; pageID keeps the same file in two split panes apart.
    const lineStart = ctx.getSectionInfo(el)?.lineStart;
    const blockID = `${pageID}:${lineStart ?? "unknown"}`;

    let debouncedFunc = this.debouncedMap.get(blockID);
    if (!debouncedFunc) {
      // No need to debounce initial render
      await this.export(source, el, ctx);

      debouncedFunc = debounce(this.export, this.plugin.settings.debounce, {
        leading: true,
      });
      this.debouncedMap.set(blockID, debouncedFunc);
      return;
    }

    this.abortControllerMap.get(blockID)?.abort();
    const newAbortController = new AbortController();
    this.abortControllerMap.set(blockID, newAbortController);

    await debouncedFunc(source, el, ctx, newAbortController.signal);
  };

  isValidUrl = (urlString: string) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (e) {
      return false;
    }
    return url.protocol === "http:" || url.protocol === "https:";
  };

  formatLinks = (svgEl: HTMLElement) => {
    // Add attributes to <a> tags to make them Obsidian compatible :
    const links = svgEl.querySelectorAll("a");
    links.forEach((link: HTMLElement) => {
      const href = link.getAttribute("href") ?? "";
      // Check for internal link
      if (!this.isValidUrl(href)) {
        link.classList.add("internal-link");
        link.setAttribute("data-href", href);
        link.setAttribute("target", "_blank");
        link.setAttribute("rel", "noopener");
      }
    });
  };

  sanitizeSVGIDs = (svgEl: HTMLElement, docID: string): string => {
    // append docId to <marker> || <mask> || <filter> id's so that they're unique across different panels & edit/view mode
    const overrides = svgEl.querySelectorAll("marker, mask, filter");
    const overrideIDs: string[] = [];
    overrides.forEach((override) => {
      const id = override.getAttribute("id");
      if (id) {
        overrideIDs.push(id);
      }
    });
    return overrideIDs.reduce((svgHTML, overrideID) => {
      return svgHTML.replaceAll(overrideID, [overrideID, docID].join("-"));
    }, svgEl.outerHTML);
  };

  // Identifies one diagram across re-renders. Keyed on sourcePath and NOT on
  // ctx.docId: docId is regenerated per render, so a key holding it never
  // matches on the way back and the remembered state is silently lost.
  blockKey(el: HTMLElement, ctx: MarkdownPostProcessorContext): string {
    return `${ctx.sourcePath}:${ctx.getSectionInfo(el)?.lineStart ?? "unknown"}`;
  }

  insertImage(image: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    const parser = new DOMParser();
    const svg = parser.parseFromString(image, "image/svg+xml");
    const containerEl = el.createDiv({ cls: "D2__Diagram" });

    const svgEl = svg.documentElement;
    svgEl.style.maxHeight = `${this.plugin.settings.containerHeight}px`;
    svgEl.style.maxWidth = "100%";
    svgEl.style.height = "fit-content";
    svgEl.style.width = "fit-content";

    // d2 paints its canvas with a single rect, the first child of the inner
    // <svg>. There is no CLI flag for this, and a root `style.fill` does not
    // reach it — dropping that one fill is the only lever.
    //
    // It has to be an INLINE STYLE. d2 embeds `.fill-N7 { fill: … }`, and in SVG
    // a stylesheet rule outranks a presentation attribute, so setting fill="none"
    // changes the DOM and nothing else: the canvas stays painted.
    if (this.plugin.settings.transparentBackground) {
      const background = svgEl.querySelector("svg > rect");
      background?.setAttribute("style", "fill: none");
    }

    this.formatLinks(svgEl);
    containerEl.innerHTML = this.sanitizeSVGIDs(svgEl, ctx.docId);

    // A re-render fires on edit and on scroll, so the chosen size has to outlive
    // the element it was chosen on — otherwise it resets under the reader.
    if (this.actualSizeMap.get(this.blockKey(el, ctx))) {
      containerEl.addClass("D2__Diagram--actual");
    }
  }

  export = async (
    source: string,
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext,
    signal?: AbortSignal
  ) => {
    try {
      const image = await this.generatePreview(source, signal);
      if (image) {
        el.empty();
        this.prevImage = image;
        this.insertImage(image, el, ctx);

        const toolbar = el.createDiv({ cls: "Preview__Toolbar" });

        const recompile = new ButtonComponent(toolbar)
          .setClass("Preview__Button")
          .setIcon("recompile")
          .onClick((e) => {
            e.preventDefault();
            e.stopPropagation();
            el.empty();
            this.attemptExport(source, el, ctx);
          });
        recompile.buttonEl.addClass("Preview__Recompile");
        recompile.buttonEl.createEl("span", { text: "Recompile" });

        // A wide diagram is scaled to fit the pane, which shrinks its text
        // rather than clipping it — unreadable well before it is unusable. This
        // drops the fit and lets the container scroll at natural size.
        const key = this.blockKey(el, ctx);
        const sizeButton = new ButtonComponent(toolbar)
          .setClass("Preview__Button")
          .setIcon("d2-actual-size");
        sizeButton.buttonEl.addClass("Preview__ActualSize");
        const sizeLabel = sizeButton.buttonEl.createEl("span", {
          text: this.actualSizeMap.get(key) ? "Fit" : "Actual size",
        });

        // One path for both the button and the double-click gesture, so the two
        // can never disagree about which state the diagram is in.
        const toggleActualSize = () => {
          const diagramEl = el.querySelector<HTMLElement>(".D2__Diagram");
          if (!diagramEl) {
            return;
          }
          const actual = !diagramEl.classList.contains("D2__Diagram--actual");
          diagramEl.classList.toggle("D2__Diagram--actual", actual);
          this.actualSizeMap.set(key, actual);
          sizeLabel.textContent = actual ? "Fit" : "Actual size";
        };

        sizeButton.onClick((e) => {
          e.preventDefault();
          e.stopPropagation();
          toggleActualSize();
        });

        const diagramEl = el.querySelector<HTMLElement>(".D2__Diagram");

        // A double-click on a link is the reader reaching for the note, not for
        // the zoom.
        const isLink = (e: MouseEvent) => !!(e.target as HTMLElement).closest("a");

        // The word is selected on the SECOND MOUSEDOWN, before dblclick fires,
        // so suppressing it there is already too late. Cancelling that mousedown
        // leaves ordinary drag-selection untouched — only the double-click's own
        // selection is given up, which is the one the gesture replaces.
        diagramEl?.addEventListener("mousedown", (e) => {
          if (e.detail > 1 && !isLink(e)) {
            e.preventDefault();
          }
        });

        diagramEl?.addEventListener("dblclick", (e) => {
          if (isLink(e)) {
            return;
          }
          e.preventDefault();
          // Anything a previous drag left highlighted would otherwise sit there
          // through the zoom.
          activeWindow.getSelection()?.removeAllRanges();
          toggleActualSize();
        });
      }
    } catch (err) {
      el.empty();
      const errorEl = el.createEl("pre", {
        cls: "markdown-rendered pre Preview__Error",
      });
      errorEl.createEl("code", {
        text: "D2 Compilation Error:",
        cls: "Preview__Error--Title",
      });
      errorEl.createEl("code", {
        text: err.message,
      });
      if (this.prevImage) {
        this.insertImage(this.prevImage, el, ctx);
      }
    } finally {
      const pageContainer = (ctx as any).containerEl;
      this.abortControllerMap.delete(pageContainer.dataset.id);
    }
  };

  async generatePreview(source: string, signal?: AbortSignal): Promise<string> {
    const pathArray = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin"];

    // platform will be win32 even on 64 bit windows
    if (os.platform() === "win32") {
      pathArray.push(`C:\Program Files\D2`);
    } else {
      pathArray.push(`${process.env.HOME}/.local/bin`);
    }

    let GOPATH = "";
    try {
      GOPATH = execSync("go env GOPATH", {
        env: {
          ...process.env,
          PATH: pathArray.join(delimiter),
        },
      }).toString();
    } catch (error) {
      // ignore if go is not installed
    }

    if (GOPATH) {
      pathArray.push(`${GOPATH.replace("\n", "")}/bin`);
    }
    if (this.plugin.settings.d2Path) {
      pathArray.push(this.plugin.settings.d2Path);
    }

    const options: any = {
      ...process.env,
      env: {
        PATH: pathArray.join(delimiter),
      },
      signal,
    };
    if (this.plugin.settings.apiToken) {
      options.env.TSTRUCT_TOKEN = this.plugin.settings.apiToken;
    }

    let args = [
      `d2`,
      "-",
      `--theme=${this.plugin.settings.theme}`,
      `--layout=${this.plugin.settings.layoutEngine}`,
      `--pad=${this.plugin.settings.pad}`,
      `--sketch=${this.plugin.settings.sketch}`,
      "--bundle=false",
      "--scale=1",
    ];
    const cmd = args.join(" ");
    const child = exec(cmd, options);
    child.stdin?.write(source);
    child.stdin?.end();

    let stdout: any;
    let stderr: any;

    if (child.stdout) {
      child.stdout.on("data", (data) => {
        if (stdout === undefined) {
          stdout = data;
        } else {
          stdout += data;
        }
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (data) => {
        if (stderr === undefined) {
          stderr = data;
        } else {
          stderr += data;
        }
      });
    }

    return new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code: number) => {
        if (code === 0) {
          resolve(stdout);
          return;
        } else if (stderr) {
          console.error(stderr);
          reject(new Error(stderr));
        } else if (stdout) {
          console.error(stdout);
          reject(new Error(stdout));
        }
      });
    });
  }
}

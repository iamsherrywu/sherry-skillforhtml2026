import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildSingleHtml, verifyProjectDeckParity } from "../scripts/build-single-html.mjs";

function makeProject({ outputs = ["html", "pptx"], chapter, model } = {}) {
  const projectDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "sherry-parity-"));
  fs.mkdirSync(path.join(projectDir, "slides"));
  fs.writeFileSync(path.join(projectDir, "project-status.json"), `${JSON.stringify({
    schemaVersion: 1,
    projectName: "Parity deck",
    entryMode: "topic-start",
    currentGate: "chapters",
    approvedGates: [],
    outputs,
    speakerNotes: false,
    primaryStyleId: "product-narrative",
    secondaryStyleId: null,
    fastMode: false,
    currentChapter: "chapter-01",
    updatedAt: "2026-08-03T00:00:00.000Z",
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(projectDir, "slides", "chapter-01.html"), chapter ?? validChapter());
  if (model !== null) {
    fs.writeFileSync(path.join(projectDir, "deck-model.json"), `${JSON.stringify(model ?? validModel(), null, 2)}\n`);
  }
  return projectDir;
}

function validModel() {
  return {
    meta: {
      title: "Parity deck",
      styleId: "product-narrative",
      secondaryStyleId: null,
      aspectRatio: "16:9",
    },
    slides: [
      {
        id: "p01",
        type: "cover",
        title: "One source of truth",
        subtitle: "HTML and PPTX stay aligned",
        body: ["Release briefing"],
        metric: null,
        sections: [],
        sourceRefs: ["Approved outline p01"],
      },
      {
        id: "p02",
        type: "process",
        title: "A checked production loop",
        subtitle: "Every step is visible",
        body: [],
        metric: null,
        sections: [
          { title: "Draft", body: "Create the chapter source." },
          { title: "Check", body: "Compare both output formats." },
        ],
        sourceRefs: [],
      },
    ],
  };
}

function validChapter() {
  return `<section class="slide" id="p01" data-slide-type="cover">
  <p data-decorative>OPENING</p>
  <h1 data-deck-title data-deck-text>One source of truth</h1>
  <p data-deck-text>HTML and PPTX stay aligned</p>
  <p data-deck-text>Release briefing</p>
  <footer data-source-ref>Approved outline p01</footer>
</section>
<section class="slide" id="p02" data-slide-type="process">
  <h2 data-deck-title data-deck-text>A checked production loop</h2>
  <p data-deck-text>Every step is visible</p>
  <div><strong data-deck-text>Draft</strong><p data-deck-text>Create the chapter source.</p></div>
  <div><strong data-deck-text>Check</strong><p data-deck-text>Compare both output formats.</p></div>
</section>\n`;
}

test("dual-format projects verify order, titles, visible text, and source references", () => {
  const projectDir = makeProject();
  const parity = verifyProjectDeckParity({ projectDir });
  const outputFile = path.join(projectDir, "outputs", "deck.html");
  const build = buildSingleHtml({ projectDir, outputFile });

  assert.equal(parity.ok, true);
  assert.equal(parity.slideCount, 2);
  assert.deepEqual(parity.slides.map(({ id }) => id), ["p01", "p02"]);
  assert.equal(build.parityManifest.ok, true);
  assert.equal(fs.existsSync(outputFile), true);
});

test("parity rejects slide order, title, visible-text, source, and untracked-text divergence", () => {
  const cases = [
    {
      name: "order",
      chapter: validChapter().replace(/(<section class="slide" id="p01"[\s\S]*?<\/section>)\n(<section class="slide" id="p02"[\s\S]*?<\/section>)/, "$2\n$1"),
      error: /order|expected p01|slide 1/i,
    },
    {
      name: "title",
      chapter: validChapter().replace("One source of truth</h1>", "A different title</h1>"),
      error: /p01.*title/i,
    },
    {
      name: "screen text",
      chapter: validChapter().replace("Release briefing</p>", "Different screen text</p>"),
      error: /p01.*screen text|visible text/i,
    },
    {
      name: "source",
      chapter: validChapter().replace("Approved outline p01</footer>", "Different source</footer>"),
      error: /p01.*source/i,
    },
    {
      name: "untracked visible text",
      chapter: validChapter().replace("</section>\n<section class=\"slide\" id=\"p02\"", "<p>Untracked copy</p></section>\n<section class=\"slide\" id=\"p02\""),
      error: /p01.*untracked|unclassified.*visible/i,
    },
  ];

  for (const fixture of cases) {
    const projectDir = makeProject({ chapter: fixture.chapter });
    assert.throws(() => verifyProjectDeckParity({ projectDir }), fixture.error, fixture.name);
    assert.throws(
      () => buildSingleHtml({ projectDir, outputFile: path.join(projectDir, "outputs", "deck.html") }),
      fixture.error,
      fixture.name,
    );
  }
});

test("dual-format HTML build requires a canonical model while HTML-only remains independent", () => {
  const dualProject = makeProject({ model: null });
  assert.throws(
    () => buildSingleHtml({ projectDir: dualProject, outputFile: path.join(dualProject, "deck.html") }),
    /deck-model\.json|canonical.*model|parity/i,
  );

  const htmlProject = makeProject({ outputs: ["html"], model: null });
  const result = buildSingleHtml({ projectDir: htmlProject, outputFile: path.join(htmlProject, "deck.html") });
  assert.equal(result.parityManifest, null);
});

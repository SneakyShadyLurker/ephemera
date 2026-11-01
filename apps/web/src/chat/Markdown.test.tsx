import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown.tsx";

const render = (text: string, streaming = false) =>
  renderToStaticMarkup(<Markdown streaming={streaming}>{text}</Markdown>);

/** Untrusted text (PRINCIPLES.md 3): nothing it contains may load, run or navigate. */
describe("Markdown renders untrusted text inert", () => {
  it("keeps a single line break", () => {
    const out = render('*She looks up.*\n"You came back."\n\nThe fire cracks.');
    expect(out).toMatch(
      /<em>She looks up\.<\/em><br\/?>\n?<span data-voice="speech">\u201cYou came back\.\u201d<\/span><\/p>/,
    );
    expect(out.match(/<p\b/g)).toHaveLength(2);
  });

  it("does not break inside a code block", () => {
    const out = render("```\nline one\nline two\n```");
    expect(out).not.toMatch(/<br/);
  });

  it("renders roleplay actions as emphasis, with typographic quotes", () => {
    const out = render(`*She waits.* "Well? It's late."`);
    expect(out).toContain("<em>She waits.</em>");
    expect(out).toContain("\u201cWell? It\u2019s late.\u201d");
  });

  it("renders a 90,000-word paragraph quickly, leaving its quotes straight", () => {
    const long = `"It's ${"word ".repeat(90_000)}"`;
    const before = process.cpuUsage();
    const out = render(`"Short," she says.\n\n${long}`);
    const { user, system } = process.cpuUsage(before);
    expect((user + system) / 1000).toBeLessThan(3_000);
    expect(out.match(/<p\b/g)).toHaveLength(2);
    const [short, rest = ""] = out.split("</p>");
    expect(short).toContain("\u201cShort,\u201d");
    // The whole paragraph renders, every word of it, with its quotes left straight.
    expect(rest.split("word").length - 1).toBe(90_000);
    expect(rest).toContain("&quot;It&#x27;s word");
    expect(rest).not.toMatch(/[\u201c\u201d\u2019]/);
  });

  it("does not fade in a burst of text too long to animate word by word", () => {
    const out = render(`${"word ".repeat(2_000)}end`, true);
    expect(out.split("word").length - 1).toBe(2_000);
    expect(out).not.toContain("data-sd-animate");
  });

  it.each([
    ["script", "<script>alert(1)</script>"],
    ["image handler", '<img src="x" onerror="alert(1)">'],
    ["iframe", '<iframe src="https://evil.example"></iframe>'],
    ["style", "<style>body{display:none}</style>"],
    ["event attribute", '<div onclick="alert(1)">hi</div>'],
    ["link element", '<a href="https://evil.example">x</a>'],
  ])("does not turn raw HTML (%s) into elements", (_label, html) => {
    const out = render(`Before ${html} after`);
    expect(out).not.toMatch(/<(script|img|iframe|style|a|div onclick)\b/i);
    expect(out).not.toMatch(/<[a-z][^>]*\son\w+=/i);
  });

  it.each([
    [
      "https link",
      "[the board](https://harbour.example/crossings)",
      "https://harbour.example/crossings",
    ],
    ["relative link", "[home](/characters)", "/characters"],
    ["reference link", "[map][m]\n\n[m]: https://maps.example/river", "https://maps.example/river"],
    ["mailto link", "[write](mailto:keeper@example.org)", "mailto:keeper@example.org"],
  ])("shows a %s destination as text without a link", (_label, markdown, destination) => {
    const out = render(markdown);
    expect(out).not.toContain("<a");
    expect(out).not.toContain("href=");
    expect(out).toContain(destination);
  });

  it("decodes named character references as text", () => {
    expect(render("Tom &amp; Jerry &mdash; &lt;b&gt;fin&lt;/b&gt;")).toContain(
      "Tom &amp; Jerry \u2014 &lt;b&gt;fin&lt;/b&gt;",
    );
  });

  it("shows an autolink once, as text", () => {
    const out = render("See https://harbour.example/crossings today");
    expect(out).not.toContain("<a");
    expect(out.split("https://harbour.example/crossings")).toHaveLength(2);
  });

  it("drops script and data URLs without making them active", () => {
    for (const markdown of ["[x](javascript:alert(1))", "[x](data:text/html,<script>1</script>)"]) {
      const out = render(markdown);
      expect(out).not.toContain("<a");
      expect(out).not.toContain("href=");
      expect(out).not.toMatch(/<script/i);
    }
  });

  it.each([
    [
      "remote image",
      "![a lantern](https://images.example/lantern.png)",
      "https://images.example/lantern.png",
    ],
    ["data image", "![dot](data:image/png;base64,iVBORw0KGgo=)", null],
    ["relative image", "![avatar](/avatars/1.png)", "/avatars/1.png"],
  ])("never loads a %s", (_label, markdown, destination) => {
    const out = render(markdown);
    expect(out).not.toMatch(/<img\b/i);
    expect(out).not.toMatch(/\ssrc=/i);
    if (destination) expect(out).toContain(destination);
  });

  it("offers no download or copy controls on code and tables", () => {
    const out = render("```js\nconst a = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |");
    expect(out).toContain("const a = 1;");
    expect(out).not.toMatch(/download|copy/i);
  });

  it("does not show raw markers for incomplete Markdown while streaming", () => {
    for (const partial of ["The **river", "She said *wait", "[the board](https://harb"]) {
      const out = render(partial, true);
      expect(out).not.toContain("**");
      expect(out).not.toMatch(/\*w/);
      expect(out).not.toContain("<a");
    }
  });
});

describe("Markdown highlights", () => {
  /** A streamed render without Streamdown's per-word fade spans. */
  const streamed = (text: string) =>
    render(text, true)
      .replace(/<span data-sd-animate[^>]*>([^<]*)<\/span>/g, "$1")
      .replace(/ data-sd-animated="true"/g, "");
  const textOf = (html: string) => html.replace(/<[^>]+>/g, "");

  it.each([
    ["rose", "*leans in and :rose[kisses his neck]*"],
    ["rose", "> Mara, :sage[shy], :rose[fetishes: cum, anal; taboos: none], at the bus stop"],
    ["sage", "> Mara, :sage[shy and timid], at the bus stop"],
    [
      "iris",
      "> Mara, green eyes, :iris[75B, small perky breasts, shaved pussy, round ass], grey hoodie",
    ],
    ["mist", ":mist[Rain drums on the shelter roof.]"],
  ])("marks :%s[...] with its tone", (tone, markdown) => {
    const out = render(markdown);
    expect(out).toMatch(new RegExp(`<span data-tone="${tone}">[^<]+</span>`));
    expect(out).not.toContain(`:${tone}[`);
  });

  it("keeps Markdown inside a highlight and a highlight inside Markdown", () => {
    expect(render(":rose[*slides closer*]")).toContain(
      '<span data-tone="rose"><em>slides closer</em></span>',
    );
    expect(render("*she :iris[smiles]*")).toContain(
      '<em>she <span data-tone="iris">smiles</span></em>',
    );
    expect(render(":mist[Rain falls as she :rose[kisses him].]")).toContain(
      '<span data-tone="mist">Rain falls as she <span data-tone="rose">kisses him</span>.</span>',
    );
  });

  it.each([
    ["emoticon", "She grins :D and waves.", "She grins :D and waves."],
    ["title", "They watched Re:Zero all night.", "They watched Re:Zero all night."],
    ["unknown tone", "A :red[warning] sign.", "A :red[warning] sign."],
    ["empty highlight", "Nothing :rose[] here.", "Nothing :rose[] here."],
    ["bare tone", "A :rose by any name.", "A :rose by any name."],
    ["leaf line", "::note[hello]", "::note[hello]"],
  ])("leaves a %s as the text it was written as", (_label, markdown, text) => {
    const out = render(markdown);
    expect(out).not.toContain("data-tone");
    expect(out).not.toMatch(/<(div|span)>/);
    expect(out).toContain(text);
  });

  it("keeps the Markdown inside a directive it leaves as text", () => {
    const out = render('A :gold[*glint*]{.x} here, "quoted".');
    expect(out).toContain(
      ':gold[<em>glint</em>]{.x} here, <span data-voice="speech">\u201cquoted\u201d</span>.',
    );
  });

  it("leaves the rest of a reply formatted after a stray container line", () => {
    const out = render(
      'Park, evening\n\n:::scene\n\n*She walks in.* "Hi," she says.\n\n> present:\n> Mara, :sage[shy]',
    );
    expect(out).toContain(":::scene");
    expect(out).toContain("<em>She walks in.</em>");
    expect(out).toMatch(/<blockquote[^>]*>[\s\S]*<span data-tone="sage">shy<\/span>/);
  });

  it("leaves no quote markers inside a directive restored in a quote", () => {
    for (const markdown of ["> :::note\n> *hi*\n> :::", "> a :x[hello\n> world] b"]) {
      const out = render(markdown);
      expect(out).toMatch(/<blockquote/);
      expect(textOf(out)).not.toContain("&gt;");
    }
    expect(render("> :::note\n> *hi*\n> :::")).toContain("<em>hi</em>");
  });

  it("drops a highlight's attributes", () => {
    const out = render(':rose[kiss]{#x .y onclick="alert(1)" style="color:red"}');
    expect(out).toContain('<span data-tone="rose">kiss</span>');
    expect(out).not.toMatch(/onclick|style=|id="|class="y/);
  });

  it("leaves a highlight in code literal", () => {
    const out = render("`:rose[kiss]`");
    expect(out).not.toContain("data-tone");
    expect(out).toContain(":rose[kiss]");
  });

  it.each([
    ["*leans in and :rose[slides her", "rose", "slides her"],
    [":rose[*slides her", "rose", "<em>slides her</em>"],
    ["> Mara, :sage[shy and", "sage", "shy and"],
  ])("shows %j highlighted from its first streamed word", (partial, tone, inner) => {
    const out = streamed(partial);
    expect(out).toMatch(new RegExp(`<span data-tone="${tone}"[^>]*>${inner}</span>`));
    expect(textOf(out)).not.toMatch(/:(rose|sage)|\*|\[|streamdown:/);
  });

  it("shows no link placeholder for an open directive or an escaped bracket", () => {
    for (const partial of [
      "She whispers :gold[my lov",
      "*she :pink[slides",
      ":rose[\\[thing",
      "\\\\:rose[hello",
      ":mist[Rain falls as she :rose[kisses",
      ":mist[The sign reads [Closed",
      ":rose[kisses him](gently",
      ":mist[a :rose[b](c",
      ":mist[a [link](http://x",
      "Elle dit :café[bonjour",
      "Room :9b[nine",
    ]) {
      expect(textOf(streamed(partial))).not.toContain("streamdown:");
    }
    expect(streamed(":mist[Rain falls as she :rose[kisses")).toMatch(
      /<span data-tone="mist">Rain falls as she <span data-tone="rose">kisses<\/span><\/span>/,
    );
  });

  it("holds back an open parenthesis after a label until it closes", () => {
    expect(textOf(streamed(":mist[a :rose[b](c"))).toBe("a b");
    expect(textOf(streamed(":rose[kisses him](gently"))).toBe("kisses him");
    expect(textOf(streamed(":rose[kisses him](gently)"))).toBe("kisses him(gently)");
  });

  it("closes emphasis inside the label it opened in", () => {
    expect(streamed(":mist[She *pulls him closer and :rose[slides her")).toContain(
      '<span data-tone="mist">She <em>pulls him closer and <span data-tone="rose">slides her</span></em></span>',
    );
  });

  it("restores nested unknown directives once", () => {
    for (const markdown of [":gold[:x[hi]]", ":gold[a :x[hi]{.c}]"]) {
      expect(textOf(render(markdown))).toBe(markdown);
    }
  });

  it("parses no container directives, however deeply they would nest", () => {
    const started = performance.now();
    const out = render(`${":::x\n".repeat(5000)}text`);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(out).toContain(":::x");
    expect(out).toContain("text");
  });

  it("leaves highlights nested past the limit open, cheaply", () => {
    const started = performance.now();
    render(":rose[a ".repeat(3000), true);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it("closes highlights nested up to the limit", () => {
    const out = streamed(`${":mist[a *b ".repeat(8)}c`);
    expect(out.match(/<span data-tone="mist">/g)).toHaveLength(8);
    expect(textOf(out)).not.toMatch(/:mist|\*|\[|\]|streamdown:/);
  });

  it("keeps an unclosed highlight in an earlier paragraph from closing in the next", () => {
    for (const partial of [
      ":rose[left open\n\nThe next line",
      ":rose[kiss](she laughs\n\nAnother paragraph follows here",
      "A stray ` tick\n\n:rose[kiss",
    ]) {
      const out = textOf(streamed(partial));
      expect(out).not.toMatch(/\]$|streamdown:/);
    }
    expect(textOf(streamed(":rose[kiss](she laughs\n\nAnother paragraph follows here"))).toContain(
      "Another paragraph",
    );
    expect(streamed("A stray ` tick\n\n:rose[kiss")).toContain(
      '<span data-tone="rose">kiss</span>',
    );
  });

  it("leaves a highlight in a tilde fence literal while it streams", () => {
    expect(textOf(streamed("~~~\n:rose[kiss"))).toContain(":rose[kiss");
  });

  it("keeps Markdown inside a directive line that is not a highlight", () => {
    expect(render("::note[hello *world*]")).toContain("<em>world</em>");
  });

  it("holds back a tone name still streaming in", () => {
    for (const partial of ["*leans in and :ro", "*leans in and :rose", "*leans in and :rose["]) {
      expect(textOf(streamed(partial))).toBe("leans in and");
    }
    expect(textOf(streamed("She grins :D"))).toBe("She grins :D");
  });
});

describe("Markdown scene voices", () => {
  const streamed = (text: string) =>
    render(text, true)
      .replace(/<span data-sd-animate[^>]*>([^<]*)<\/span>/g, "$1")
      .replace(/ data-sd-animated="true"/g, "");
  const textOf = (html: string) => html.replace(/<[^>]+>/g, "");

  it.each([
    ["curly", "“Wow, are you for real?” she asks."],
    ["straight", '"Wow, are you for real?" she asks.'],
    ["low-high", "„Wow, are you for real?“ she asks."],
    ["guillemet", "«Wow, are you for real?» she asks."],
  ])("sets %s quotes apart as speech, quotes included", (_label, markdown) => {
    expect(render(markdown)).toMatch(
      /<span data-voice="speech">[“„«]Wow, are you for real\?[”“»]<\/span> she asks\./,
    );
  });

  it("keeps emphasis inside speech in the speech", () => {
    expect(render('"I *really* mean it." She nods.')).toContain(
      '<span data-voice="speech">“I </span><em><span data-voice="speech">really</span></em><span data-voice="speech"> mean it.”</span> She nods.',
    );
  });

  it("runs a quote still open to the end of its paragraph", () => {
    const out = render('She turns. "Wait, I *never*\n\nThe door shuts.');
    expect(out).toContain(
      '<span data-voice="speech">“Wait, I </span><em><span data-voice="speech">never</span></em></p>',
    );
    expect(out).toContain('<p data-scene-line="narration">The door shuts.</p>');
  });

  it("starts no speech at an apostrophe or inside an action", () => {
    expect(render("It's late")).not.toContain("data-voice");
    expect(render('*mouths "no"* and leaves')).not.toContain("data-voice");
  });

  it("sets a cue apart, its colon kept in the text", () => {
    const out = render('Kate (25): "Wow, are you for real?"');
    expect(out).toMatch(
      /<p data-scene-line="cue"><span data-cue=""><span data-cue-name="">Kate<\/span> <span data-cue-age="">\(25\)<\/span><span data-cue-separator="">: <\/span><\/span><span data-voice="speech">/,
    );
    expect(textOf(out)).toBe("Kate (25): “Wow, are you for real?”");
  });

  it("leaves a line that only looks like a cue as narration", () => {
    for (const markdown of ["Note: the gate is closed.", "12:30 came and went."]) {
      const out = render(markdown);
      expect(out).not.toContain("data-cue");
      expect(out).toContain('<p data-scene-line="narration">');
    }
  });

  it("renders a thought and marks its line", () => {
    const out = render("Kate (25): :thought[oh wow... what do I do now...]");
    expect(out).toContain('<p data-scene-line="thought">');
    expect(out).toMatch(/<span data-voice="thought">oh wow… what do I do now…<\/span>/);
    expect(out).not.toContain(":thought[");
  });

  it("marks an action line as a cue line", () => {
    expect(render("Kate (25): *jumps up in shock*")).toContain(
      '<p data-scene-line="cue"><span data-cue=""><span data-cue-name="">Kate</span> <span data-cue-age="">(25)</span><span data-cue-separator="">: </span></span><em>jumps up in shock</em></p>',
    );
  });

  it("leaves lines inside a blockquote as they are", () => {
    const out = render('> Kate (25): "Hi" she says, :thought[oh]');
    expect(out).toMatch(/<blockquote/);
    expect(out).not.toMatch(/data-cue|data-scene-line|data-voice="speech"/);
  });

  it("names each woman at the head of her line in the present block", () => {
    const out = render(
      "> present:\n> Mara O'Neil, 18 years old, :rose[virgin], shy\n> Kate, 20, waiting\n>\n> Ana, 30, reading\n\n> Peggy Wong, 25 years old",
    );
    const names = [...out.matchAll(/<span data-present-name="">([^<]*)<\/span>/g)].map(
      ([, name]) => name,
    );
    expect(names).toEqual(["Mara O’Neil", "Kate", "Ana"]);
    expect(textOf(out)).toContain("present:\nMara O’Neil, 18 years old, virgin, shy\nKate, 20");
  });

  it.each([
    ["the location line", "> Location: Mara's flat, late evening"],
    ["an empty present block", "> present: none"],
    ["a line without a comma", "> present:\n> Mara"],
    ["a line that opens with markup", "> present:\n> :rose[Mara] Battin, 18 years old"],
    ["a scene line", "Mara, 18, waits."],
  ])("names no one in %s", (_label, markdown) => {
    expect(render(markdown)).not.toContain("data-present-name");
  });

  it("names a woman once her name has streamed in", () => {
    expect(streamed("> present:\n> Mara Batt")).not.toContain("data-present-name");
    expect(streamed("> present:\n> Mara Battin, 18")).toMatch(
      /<span data-present-name=""[^>]*>Mara Battin<\/span>/,
    );
  });

  it("shows a thought from its first streamed word", () => {
    const out = streamed("Kate (25): :thought[oh wo");
    expect(out).toContain('data-scene-line="thought"');
    expect(out).toMatch(/<span data-voice="thought"[^>]*>oh wo<\/span>/);
    expect(textOf(out)).not.toContain(":thought[");
  });

  it("holds back a thought mark still streaming in", () => {
    expect(textOf(streamed("Kate (25): *nods* :tho"))).toBe("Kate (25): nods");
  });

  it("ends speech at a quote that closes inside bold", () => {
    const out = render('"Stop **now!"** she says, then walks.');
    expect(out).toContain('<span data-voice="speech">“Stop </span>');
    expect(out).toMatch(
      /<span[^>]*data-streamdown="strong"[^>]*><span data-voice="speech">now!”<\/span><\/span> she says, then walks\.<\/p>/,
    );
  });

  it("ends speech at a quote that closes inside emphasis", () => {
    const out = render("“Stop *now!”* she says.");
    expect(out).toMatch(/<em><span data-voice="speech">now!”<\/span><\/em> she says\.<\/p>/);
    expect(render('*mouths "no"* and leaves')).not.toContain("data-voice");
  });

  it("starts speech written straight after an action or a highlight", () => {
    for (const markdown of ['*smiles*"Hello," she says.', ':rose[kisses him]"Hello," she says.']) {
      expect(render(markdown)).toMatch(/<span data-voice="speech">“Hello,”<\/span> she says\./);
    }
  });

  it.each([
    ["after an action", 'Camila (18): *pockets the phone* "...Why?"'],
    ["after narration", 'She waits. "…Why?"'],
    ["after a cue", 'Camila (18): "...Alright. Yeah."'],
    ["written curled the wrong way", "She waits. ”…Why?”"],
  ])("opens speech that starts with an ellipsis %s", (_label, markdown) => {
    expect(render(markdown)).toMatch(/<span data-voice="speech">“…[A-Z][^<”]*”<\/span><\/p>/);
  });

  it("keeps a closing quote that follows an open one", () => {
    const out = render('"Wait..." she says. "Now."');
    expect(out).toContain('<span data-voice="speech">“Wait…”</span> she says.');
    expect(out).toContain('<span data-voice="speech">“Now.”</span>');
  });

  it("keeps a cue's name visible while its words fade in", () => {
    const out = render('Kate (25): "Hi', true);
    const separator = /<span data-cue-separator=""[^>]*>.*?<\/span><\/span>/.exec(out)?.[0] ?? "";
    expect(separator).not.toBe("");
    expect(separator).not.toContain("Kate");
    expect(out).toMatch(/<span data-cue-name=""[^>]*><span data-sd-animate[^>]*>Kate/);
  });

  it("holds back a cue until its line's text starts, so it never shows as narration", () => {
    for (const arriving of ["Kate", "Kate (2", "Kate (25):", "Kate (25): "]) {
      expect(textOf(streamed(`Rain falls.\n\n${arriving}`))).toBe("Rain falls.");
    }
    expect(textOf(streamed("Rain falls.\n\nThe knock comes softly"))).toContain("comes softly");
    expect(streamed('Rain falls.\n\nKate (25): "H')).toContain('data-scene-line="cue"');
  });

  it("does not turn a raw voice or cue span into an element", () => {
    const out = render(
      '<span data-voice="speech">x</span> <span data-voice="thought">y</span> <span data-cue>z</span>',
    );
    expect(out).not.toMatch(
      /<span data-voice="(speech|thought)">[xy]<\/span>|<span data-cue[^>]*>z/,
    );
  });
});

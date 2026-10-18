// Use the pinned runtime's CommonMark parser; no scanner-only dependency.
const sources = JSON.parse(await Bun.stdin.text());
console.log(JSON.stringify(sources.map(source => Bun.markdown.html(source))));

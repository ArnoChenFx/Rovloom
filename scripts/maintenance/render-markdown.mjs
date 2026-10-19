// 使用固定 Bun 运行时的 CommonMark 解析器，将标准输入中的 Markdown 数组转换为 HTML。
const sources = JSON.parse(await Bun.stdin.text())
console.log(JSON.stringify(sources.map(/* 将单篇 Markdown 转换为 HTML。 */ (source) => Bun.markdown.html(source))))

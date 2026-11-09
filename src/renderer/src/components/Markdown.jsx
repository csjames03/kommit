// Minimal Markdown for Claude's status updates: paragraphs, "- " lists, **bold**, `code`.
// Builds React elements (no innerHTML), so model output can't inject markup.

function inline(text) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={i}>{part.slice(1, -1)}</code>
    return part
  })
}

export default function Markdown({ text }) {
  const blocks = []
  let list = null
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd()
    const item = line.match(/^\s*[-*]\s+(.*)/)
    if (item) {
      if (!list) blocks.push((list = { type: 'ul', items: [] }))
      list.items.push(item[1])
      continue
    }
    list = null
    if (!line.trim()) continue
    const heading = line.match(/^#{1,6}\s+(.*)/)
    blocks.push({ type: heading ? 'h' : 'p', text: heading ? heading[1] : line })
  }
  return (
    <div className="md">
      {blocks.map((b, i) =>
        b.type === 'ul' ? (
          <ul key={i}>
            {b.items.map((it, j) => (
              <li key={j}>{inline(it)}</li>
            ))}
          </ul>
        ) : b.type === 'h' ? (
          <p key={i}>
            <strong>{inline(b.text)}</strong>
          </p>
        ) : (
          <p key={i}>{inline(b.text)}</p>
        )
      )}
    </div>
  )
}

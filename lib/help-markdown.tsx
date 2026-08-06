// Minimal markdown renderer for the help content — headings (##/###),
// paragraphs, - bullet lists, and **bold**. The docs are authored to exactly
// this subset (enforced by convention in docs/help), which keeps the help
// system dependency-free.

import { Fragment, type ReactNode } from 'react'

function inline(text: string, keyBase: string): ReactNode[] {
  const parts = text.split(/\*\*([^*]+)\*\*/g)
  return parts.map((p, i) =>
    i % 2 === 1 ? <strong key={`${keyBase}-${i}`}>{p}</strong> : <Fragment key={`${keyBase}-${i}`}>{p}</Fragment>,
  )
}

export function renderHelpMarkdown(body: string): ReactNode {
  const blocks: ReactNode[] = []
  const lines = body.split(/\r?\n/)
  let para: string[] = []
  let list: string[] = []
  let key = 0

  const flushPara = () => {
    if (para.length > 0) {
      blocks.push(<p key={key++} className="text-sm leading-relaxed text-slate-700">{inline(para.join(' '), `p${key}`)}</p>)
      para = []
    }
  }
  const flushList = () => {
    if (list.length > 0) {
      blocks.push(
        <ul key={key++} className="list-disc pl-5 space-y-1 text-sm leading-relaxed text-slate-700">
          {list.map((item, i) => <li key={i}>{inline(item, `l${key}-${i}`)}</li>)}
        </ul>,
      )
      list = []
    }
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (line.startsWith('### ')) {
      flushPara(); flushList()
      blocks.push(<h4 key={key++} className="font-semibold text-slate-800 mt-3">{line.slice(4)}</h4>)
    } else if (line.startsWith('## ')) {
      flushPara(); flushList()
      blocks.push(<h3 key={key++} className="font-display font-bold text-brand-dark mt-4">{line.slice(3)}</h3>)
    } else if (line.startsWith('- ')) {
      flushPara()
      list.push(line.slice(2))
    } else if (line.trim() === '') {
      flushPara(); flushList()
    } else {
      flushList()
      para.push(line.trim())
    }
  }
  flushPara(); flushList()
  return <div className="space-y-2">{blocks}</div>
}

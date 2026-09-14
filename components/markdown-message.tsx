'use client'

// Markdown for assistant replies (Ask Turnrow + the how-to chat). Safe by
// construction: react-markdown never emits raw HTML (skipHtml) and only
// http/https/mailto/tel links survive its URL transform. Renders progressively
// while a reply streams — the component is memoized on its text so completed
// messages don't re-parse on every delta of the one still arriving. Links
// open in a new tab. Styling follows the brand: Montserrat headings in forest
// green, brand-green links, slate tables with zebra rows and right-aligned
// numbers.

import { memo, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

// A cell whose content reads as a number ("$4.93", "1,234", "(56.2)", "12%",
// "-$33,775.00") right-aligns with tabular figures, like every report table.
function looksNumeric(children: ReactNode): boolean {
  const text = flatten(children).trim()
  return text !== '' && /^[-+−(]?\s*[$¢]?\s*[\d,]+(\.\d+)?\s*[%¢)]?(\s*(bu|lbs|ac|\/bu|\/lb))?$/i.test(text)
}
function flatten(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flatten).join('')
  if (typeof node === 'object' && 'props' in node) return flatten((node as { props: { children?: ReactNode } }).props.children)
  return ''
}

const components: Components = {
  h1: ({ children }) => <h3 className="font-display font-bold text-brand-dark text-base mt-2 mb-1 first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="font-display font-bold text-brand-dark text-base mt-2 mb-1 first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="font-display font-semibold text-brand-dark text-sm mt-2 mb-1 first:mt-0">{children}</h4>,
  h4: ({ children }) => <h5 className="font-semibold text-slate-800 text-sm mt-2 mb-0.5 first:mt-0">{children}</h5>,
  h5: ({ children }) => <h6 className="font-semibold text-slate-800 text-sm mt-1">{children}</h6>,
  h6: ({ children }) => <h6 className="font-semibold text-slate-800 text-sm mt-1">{children}</h6>,
  p: ({ children }) => <p className="my-1 first:mt-0 last:mb-0 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="my-1 list-disc pl-5 space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 list-decimal pl-5 space-y-0.5">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-slate-900">{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-brand-deep underline decoration-dotted hover:decoration-solid break-words">
      {children}
    </a>
  ),
  code: ({ children, className }) => {
    // Fenced blocks arrive wrapped in <pre> (handled below); this is inline.
    const block = typeof className === 'string' && className.includes('language-')
    return block
      ? <code className="font-mono text-[12px]">{children}</code>
      : <code className="rounded bg-slate-200/80 px-1 py-0.5 font-mono text-[12px] text-slate-800">{children}</code>
  },
  pre: ({ children }) => (
    <pre className="my-1 overflow-x-auto rounded-lg bg-slate-800 text-slate-100 px-3 py-2 text-[12px] leading-snug">{children}</pre>
  ),
  blockquote: ({ children }) => <blockquote className="my-1 border-l-2 border-brand pl-3 text-slate-600">{children}</blockquote>,
  hr: () => <hr className="my-2 border-slate-200" />,
  table: ({ children }) => (
    <div className="my-1.5 overflow-x-auto">
      <table className="min-w-full text-[13px] border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-slate-200/70 text-slate-700">{children}</thead>,
  tbody: ({ children }) => <tbody className="[&>tr:nth-child(even)]:bg-white/60">{children}</tbody>,
  tr: ({ children }) => <tr className="border-t border-slate-200">{children}</tr>,
  th: ({ children }) => (
    <th className={`px-2 py-1 font-semibold whitespace-nowrap ${looksNumeric(children) ? 'text-right' : 'text-left'}`}>{children}</th>
  ),
  td: ({ children }) => (
    <td className={`px-2 py-1 align-top ${looksNumeric(children) ? 'text-right tabular-nums whitespace-nowrap' : ''}`}>{children}</td>
  ),
}

function MarkdownMessageImpl({ text, className }: { text: string; className?: string }) {
  return (
    <div className={`text-sm text-slate-800 break-words ${className ?? ''}`} data-testid="markdown-message">
      <Markdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {text}
      </Markdown>
    </div>
  )
}

const MarkdownMessage = memo(MarkdownMessageImpl)
export default MarkdownMessage

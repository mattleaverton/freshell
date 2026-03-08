import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

// Render Markdown synchronously in this suite so wrapper assertions don't rely
// on React.lazy timing across the full test run.
vi.mock('@/components/markdown/LazyMarkdown', async () => {
  const { MarkdownRenderer } = await import('@/components/markdown/MarkdownRenderer')
  return {
    LazyMarkdown: ({ content }: { content: string }) => (
      <MarkdownRenderer content={content} />
    ),
  }
})

import MarkdownPreview from '../../../../../src/components/panes/MarkdownPreview'

afterEach(() => cleanup())

describe('MarkdownPreview', () => {
  it('renders markdown as HTML', async () => {
    render(<MarkdownPreview content="# Hello World" />)

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Hello World')
  })

  it('renders links', async () => {
    render(<MarkdownPreview content="[Click here](https://example.com)" />)

    const link = await screen.findByRole('link', { name: /click here/i })
    expect(link).toHaveAttribute('href', 'https://example.com')
  })

  it('renders code blocks', async () => {
    render(
      <MarkdownPreview
        content={`\`\`\`js
const x = 1
\`\`\``}
      />
    )

    // Syntax highlighting splits code into multiple <span> elements for tokens,
    // so we find the <code> element and check its text content.
    const codeEl = await screen.findByText((_content, element) => {
      return element?.tagName === 'CODE' && element.textContent === 'const x = 1'
    })
    expect(codeEl).toBeInTheDocument()
  })

  it('renders empty content without error', () => {
    const { container } = render(<MarkdownPreview content="" />)
    // The prose wrapper should still render even with no content
    expect(container.querySelector('.prose')).toBeInTheDocument()
  })

  it('applies prose typography classes for styled markdown rendering', () => {
    const { container } = render(<MarkdownPreview content="# Styled" />)
    const proseEl = container.querySelector('.prose')
    expect(proseEl).toBeInTheDocument()
    expect(proseEl).toHaveClass('prose-sm')
    expect(proseEl).toHaveClass('dark:prose-invert')
  })

  it('uses semantic bg-background token instead of hardcoded colors', () => {
    const { container } = render(<MarkdownPreview content="test" />)
    const outer = container.querySelector('.markdown-preview')
    expect(outer).toHaveClass('bg-background')
    // Should NOT have hardcoded color classes
    expect(outer).not.toHaveClass('bg-white')
    expect(outer).not.toHaveClass('dark:bg-gray-900')
  })

  it('renders GFM tables', async () => {
    render(
      <MarkdownPreview
        content={`
| A | B |
|---|---|
| 1 | 2 |
`}
      />
    )

    expect(await screen.findByRole('table')).toBeInTheDocument()
  })

  describe('XSS sanitization', () => {
    it('strips script tags from markdown content', () => {
      const { container } = render(
        <MarkdownPreview content='<script>alert("xss")</script>' />
      )
      expect(container.querySelector('script')).toBeNull()
    })

    it('strips event handler attributes from HTML in markdown', () => {
      const { container } = render(
        <MarkdownPreview content='<img src=x onerror=alert(1)>' />
      )
      expect(container.querySelector('img[onerror]')).toBeNull()
    })

    it('strips iframe tags from markdown content', () => {
      const { container } = render(
        <MarkdownPreview content='<iframe src="https://evil.com"></iframe>' />
      )
      expect(container.querySelector('iframe')).toBeNull()
    })

    it('renders javascript: protocol links safely', () => {
      const { container } = render(
        <MarkdownPreview content='[click me](javascript:alert(1))' />
      )
      const link = container.querySelector('a')
      // react-markdown should either strip the link or neutralize the protocol
      if (link) {
        expect(link.getAttribute('href')).not.toContain('javascript:')
      }
    })
  })
})

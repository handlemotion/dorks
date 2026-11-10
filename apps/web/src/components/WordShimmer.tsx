/**
 * Text that shimmers word by word: each word snaps to the brand blue and back, in turn, with no fade, so a short band of blue words
 * walks across the line and starts over. Under reduced motion it is plain text. The keyframes are `word-shimmer` in styles.css.
 * One wrapping span keeps the words inline: as direct children of a flex row they would each become an item and lose their spaces.
 */
export function WordShimmer({ children }: { children: string }) {
  const words = children.split(' ')
  return (
    <span>
      {words.map((word, i) => (
        <span key={i} className="word-shimmer" style={{ animationDelay: `${i * 110}ms` }}>
          {word}
          {i < words.length - 1 ? ' ' : ''}
        </span>
      ))}
    </span>
  )
}

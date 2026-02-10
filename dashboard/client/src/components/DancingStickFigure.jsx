import { useState, useEffect } from 'react';

// Dancing stick figure animation frames - all padded to exactly 5 chars wide per line
const frames = [
  ` \\o/
  |
 / \\ `,
  `  o
 /|\\
 / \\ `,
  `  o
--|--
 / \\ `,
  `  o
 /|\\
 | | `,
  ` \\o/
  |
 / \\ `,
  `  o
 /|\\
 / \\ `,
  `  o
--|-\\
 / \\ `,
  `  o
 /|\\
 | | `,
];

export default function DancingStickFigure() {
  const [frameIndex, setFrameIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % frames.length);
    }, 250); // Dance speed

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="dancing-stick-figures" title="California Vibes~">
      {[0, 1, 2, 3, 4].map((i) => (
        <pre key={i}>{frames[frameIndex]}</pre>
      ))}
    </div>
  );
}

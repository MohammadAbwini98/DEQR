# DEQR Visual Identity & Design Tokens

## Brand Identity
DEQR features a modern, high-tech, sleek dark desktop interface inspired by AWKIT design aesthetics.

## Design Tokens (CSS Variables)

```css
:root {
  /* Color Palette */
  --deqr-bg-dark: #0f141c;
  --deqr-surface-card: #18202c;
  --deqr-surface-card-hover: #212c3d;
  --deqr-border: #2a384d;
  
  /* Accents */
  --deqr-accent-cyan: #00f2fe;
  --deqr-accent-blue: #4facfe;
  --deqr-gradient-primary: linear-gradient(135deg, #00f2fe 0%, #4facfe 100%);
  
  /* Status Colors */
  --deqr-status-success: #10b981;
  --deqr-status-warning: #f59e0b;
  --deqr-status-danger: #ef4444;
  
  /* Typography */
  --deqr-font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  
  /* Contrast */
  --deqr-text-primary: #f8fafc;
  --deqr-text-secondary: #94a3b8;
  --deqr-text-muted: #64748b;
}
```

## Theme Rules
- **Dark Mode**: Default primary theme.
- **Light Mode**: High-contrast light alternative for bright ambient scan environments.
- Contrast ratio minimum: 4.5:1 for standard text (WCAG 2.1 AA compliant).

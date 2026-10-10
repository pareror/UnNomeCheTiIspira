import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Torino Noise Monitor | Heatmap Acustica Urbana',
  description: 'Piattaforma di monitoraggio del rumore urbano per la città di Torino tramite rete di sensori Arduino slave con raggio 15m.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="it">
      <body>{children}</body>
    </html>
  );
}

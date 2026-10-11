/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['better-sqlite3'],
  allowedDevOrigins: [
    '192.168.22.103',
    '192.168.118.2',
    '127.0.0.1',
    'localhost',
    '*.local',
    '*.loca.lt',
  ],
};

export default nextConfig;

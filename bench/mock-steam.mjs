import http from 'node:http';
import zlib from 'node:zlib';

const PORT = Number.parseInt(process.env.PORT || '80', 10);

// Realistic ~1.1 KiB Steam GetPlayerSummaries payload, pre-compressed for low mock overhead.
const samplePlayerJson = JSON.stringify({
  response: {
    players: [
      {
        steamid: '76561197960435530',
        communityvisibilitystate: 3,
        profilestate: 1,
        personaname: 'Robin',
        commentpermission: 1,
        profileurl: 'https://steamcommunity.com/id/robinwalker/',
        avatar: 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb.jpg',
        avatarmedium: 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_medium.jpg',
        avatarfull: 'https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg',
        avatarhash: 'fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb',
        lastlogoff: 1700000000,
        personastate: 1,
        realname: 'Robin Walker',
        primaryclanid: '103582791429521412',
        timecreated: 1063407589,
        personastateflags: 0,
        loccountrycode: 'US',
        locstatecode: 'WA',
      },
    ],
  },
});
const samplePlayerGzip = zlib.gzipSync(Buffer.from(samplePlayerJson, 'utf8'));
const serverInfoJson = Buffer.from(JSON.stringify({ servertime: 1795272000, servertimestring: 'Sun Nov 22 14:40:00 2026' }), 'utf8');

const server = http.createServer((req, res) => {
  const url = req.url || '/';

  if (url.startsWith('/ISteamWebAPIUtil/GetServerInfo/v0001/')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(serverInfoJson);
    return;
  }

  if (url.startsWith('/test/corrupt-gzip')) {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-encoding': 'gzip',
    });
    res.end(Buffer.from('not-valid-gzip-bytes'));
    return;
  }

  if (url.startsWith('/test/bare-403')) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  if (url.startsWith('/test/bad-key-403')) {
    res.writeHead(403, { 'content-type': 'text/html' });
    res.end('<html><body><h1>Forbidden</h1>Access is denied. Retrying will not help.</body></html>');
    return;
  }

  if (url.startsWith('/test/bad-key-401')) {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('');
    return;
  }

  if (url.startsWith('/test/plain')) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('plain-steam-body');
    return;
  }

  const acceptsGzip = (req.headers['accept-encoding'] || '').includes('gzip');
  if (acceptsGzip) {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-encoding': 'gzip',
      'content-length': samplePlayerGzip.length,
    });
    res.end(samplePlayerGzip);
  } else {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
    });
    res.end(samplePlayerJson);
  }
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`mock-steam listening on 0.0.0.0:${PORT}`);
});

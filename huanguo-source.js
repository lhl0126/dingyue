/**
 * 黄果短剧内容源（HGhub HPP 1.0 插件）
 *
 * 站点线路逻辑移植自 HGhubX 客户端：
 * - 优先使用内容接口验证可用的镜像，固定主站 https://huangguoai.com 始终保留；
 * - 镜像线路从两个地址发布页（huangguoai.pages.dev / huang-guo.pages.dev）的
 *   publish.js 中以「JS-as-data」方式解析（词法器只接受顶层字面量字符串数组
 *   `urls` / `subdomains`，绝不执行远端脚本），交错去重后与主站合并；
 * - `.ai` 导航页、内网/回环后缀、字面 IP 一律排除。
 *
 * 封面为 AES-128-CBC 密文（key/iv 与客户端一致），经宿主原生 aes-cbc 变换解密。
 * 播放地址来自 POST /api/videos/{id}/episodes/{ep}/playback（streams.main/hevc），
 * 主接口不支持或成功响应无可识别地址时，回退旧接口 GET /api/videos/{id}/play。
 */

export const meta = {
  id: 'hghub.huangguo',
  name: '黄果短剧',
  version: '1.0.1',
  protocol: 1,
  kind: 'source',
  mature: true,
  defaultHeaders: {
    Referer: 'https://huangguoai.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  },
  description: '黄果短剧内容源：主站 + 发布页镜像线路，短剧/漫剧浏览、搜索与 HLS 播放。',
};


const MAIN = 'https://huangguoai.com';
const MAIN_HOST = 'huangguoai.com';
const PUBLISH_PAGES = ['https://huangguoai.pages.dev/', 'https://huang-guo.pages.dev/'];
const MIRROR_MAX = 60;                 // 线路总数上限（含主站）
const PUBLISH_ARRAY_MAX = 256;         // 发布脚本单个数组的长度上限
const ENDPOINTS_KEY = 'endpoints:v2';  // 含探测排序的完整线路列表
const ENDPOINTS_TTL_SEC = 3600;
const PROBE_MAX = 4;
const PROBE_TIMEOUT_MS = 3000;
const PROBE_RESERVE_MS = 1000;
const PAGE_TIMEOUT_MS = 8000;
const PAGE_MAX_BYTES = 512 * 1024;
const LIST_SIZE = 20;

export default hg => {
  /* ───────── 封面 AES-128-CBC 变换（与客户端 src-tauri/src/media/image.rs 一致） ───────── */
  const COVER_TRANSFORM = {
    type: 'aes-cbc',
    key: hg.codec.base64Encode(hg.codec.utf8Encode('f5d965df75336270')),
    iv: hg.codec.base64Encode(hg.codec.utf8Encode('97b60394abc2fbe1')),
    padding: 'pkcs7',
  };

  /* ───────── 小工具 ───────── */

  const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const int = v => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };

  const imageRef = url => {
    const value = str(url);
    return value && /^https:\/\//i.test(value) ? { url: value, transform: COVER_TRANSFORM } : null;
  };

  const cursorPage = params => {
    if (!params.cursor) return 1;
    try {
      const parsed = JSON.parse(params.cursor);
      const page = Number(parsed && parsed.page);
      return Number.isInteger(page) && page > 0 ? page : 1;
    } catch {
      return 1;
    }
  };

  const nextPage = page => JSON.stringify({ page: page + 1 });

  /* ───────── 站点线路（当前选择由宿主保存，经 hg.endpoint 读取） ───────── */

  const currentBase = () => (hg.endpoint.current ? hg.endpoint.current.url : MAIN);

  const timeoutMs = (ctx, maximum) => {
    if (ctx.deadline === null) return maximum;
    const remaining = Math.floor(ctx.deadline - Date.now());
    if (remaining <= 0) throw new hg.PluginError('TIMEOUT', '调用已超时');
    return Math.min(maximum, remaining);
  };

  const isControlError = error => error && (error.code === 'CANCELLED' || error.code === 'TIMEOUT');

  const httpError = status => {
    if (status === 401) return new hg.PluginError('AUTH_REQUIRED', '请先登录');
    if (status === 404) return new hg.PluginError('NOT_FOUND', '内容不存在');
    if (status === 429) return new hg.PluginError('RATE_LIMITED', '上游请求过于频繁');
    return new hg.PluginError('UPSTREAM_ERROR', `上游返回 HTTP ${status}`);
  };

  /** 上游信封 {status, msg, data} 的解包；非信封形状原样返回。 */
  const unwrap = body => {
    if (body && typeof body === 'object' && !Array.isArray(body) && typeof body.status === 'number') {
      if (body.status !== 1) {
        const message = str(body.msg) || '接口返回失败';
        const code = /(视频|作品|内容).{0,8}不存在/.test(message) ? 'NOT_FOUND' : 'UPSTREAM_ERROR';
        throw new hg.PluginError(code, message);
      }
      return body.data !== undefined ? body.data : null;
    }
    return body;
  };

  async function apiGet(ctx, path, { query } = {}) {
    const response = await hg.http.fetch({
      url: currentBase() + path,
      query,
      responseType: 'json',
      timeoutMs: timeoutMs(ctx, 15000),
      signal: ctx.signal,
      retry: 1,
    });
    if (!response.ok) throw httpError(response.status);
    return unwrap(response.data);
  }

  async function apiPost(ctx, path, body) {
    const response = await hg.http.fetch({
      url: currentBase() + path,
      method: 'POST',
      body: { json: body || {} },
      responseType: 'json',
      timeoutMs: timeoutMs(ctx, 15000),
      signal: ctx.signal,
    });
    if (response.status === 404 || response.status === 405) {
      throw new hg.PluginError('UNSUPPORTED', '上游不支持播放接口');
    }
    if (!response.ok) throw httpError(response.status);
    return unwrap(response.data);
  }

  /* ───────── 发布页镜像解析（JS-as-data，绝不执行远端脚本） ───────── */

  /** 保守词法器：注释、字符串、模板与正则不能引入声明。 */
  function jsTokens(source) {
    const out = [];
    let at = 0;
    const n = source.length;
    while (at < n) {
      const ch = source[at];
      if (/\s/.test(ch)) { at++; continue; }
      if (source.startsWith('//', at)) {
        const nl = source.indexOf('\n', at);
        if (nl < 0) break;
        at = nl + 1;
        continue;
      }
      if (source.startsWith('/*', at)) {
        const end = source.indexOf('*/', at + 2);
        if (end < 0) throw new Error('发布脚本注释未闭合');
        at = end + 2;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        const start = at;
        at++;
        while (at < n && source[at] !== ch) {
          if (source[at] === '\\') at++;
          at++;
        }
        if (at >= n) throw new Error('发布脚本字符串未闭合');
        at++;
        out.push(ch === '`' ? { t: 'other' } : { t: 'str', v: source.slice(start, at) });
        continue;
      }
      if (ch === '/') {
        // 除法一律按正则处理：发布数据不含算术，歧义输入直接失败。
        at++;
        let inClass = false;
        while (at < n) {
          const c = source[at];
          if (c === '\\') { at += 2; continue; }
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) break;
          else if (c === '\n' || c === '\r') throw new Error('发布脚本包含不支持的表达式');
          at++;
        }
        if (at >= n) throw new Error('发布脚本表达式未闭合');
        at++;
        while (at < n && /[a-z]/i.test(source[at])) at++;
        out.push({ t: 'other' });
        continue;
      }
      if (/[a-z_$]/i.test(ch)) {
        const start = at;
        at++;
        while (at < n && /[\w$]/.test(source[at])) at++;
        out.push({ t: 'id', v: source.slice(start, at) });
      } else {
        out.push({ t: 'sym', v: ch });
        at++;
      }
    }
    return out;
  }

  /** 字符串字面量去引号与转义；控制字符与不支持转义直接失败。 */
  function jsUnescape(raw) {
    const body = raw.slice(1, -1);
    let out = '';
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch !== '\\') {
        const code = ch.codePointAt(0);
        if (code < 0x20 || code === 0x7f) throw new Error('镜像字符串含控制字符');
        out += ch;
        continue;
      }
      i++;
      const esc = body[i];
      if (esc === '\\' || esc === "'" || esc === '"' || esc === '/') {
        out += esc;
      } else if (esc === 'x') {
        const code = body.slice(i + 1, i + 3);
        i += 2;
        if (!/^[0-9a-f]{2}$/i.test(code)) throw new Error('镜像字符串转义无效');
        out += String.fromCharCode(parseInt(code, 16));
      } else if (esc === 'u') {
        const code = body.slice(i + 1, i + 5);
        i += 4;
        if (!/^[0-9a-f]{4}$/i.test(code)) throw new Error('镜像字符串转义无效');
        const cp = parseInt(code, 16);
        if (cp > 0x10ffff) throw new Error('镜像字符串转义无效');
        out += String.fromCodePoint(cp);
      } else {
        throw new Error('镜像字符串含不支持的转义');
      }
    }
    return out;
  }

  /** 只接受顶层 var/let/const 的字面量字符串数组。 */
  function jsArray(tokens, name) {
    let depth = 0;
    let result = null;
    for (let at = 0; at < tokens.length; at++) {
      const token = tokens[at];
      const isDecl = token.t === 'id' && (token.v === 'var' || token.v === 'let' || token.v === 'const');
      if (depth === 0 && isDecl && tokens[at + 1] && tokens[at + 1].t === 'id' && tokens[at + 1].v === name) {
        if (result !== null) throw new Error(`发布脚本重复声明 ${name}`);
        const eq = tokens[at + 2];
        const bracket = tokens[at + 3];
        if (!eq || eq.t !== 'sym' || eq.v !== '=' || !bracket || bracket.t !== 'sym' || bracket.v !== '[') {
          throw new Error(`发布脚本的 ${name} 必须是字符串数组`);
        }
        let cursor = at + 4;
        const values = [];
        while (!(tokens[cursor] && tokens[cursor].t === 'sym' && tokens[cursor].v === ']')) {
          const item = tokens[cursor];
          if (!item || item.t !== 'str') throw new Error(`发布脚本的 ${name} 含非字符串值`);
          if (values.length >= PUBLISH_ARRAY_MAX) throw new Error(`${name} 超出发布数组长度上限`);
          values.push(jsUnescape(item.v));
          cursor++;
          const next = tokens[cursor];
          if (next && next.t === 'sym' && next.v === ',') cursor++;
          else if (!(next && next.t === 'sym' && next.v === ']')) throw new Error(`发布脚本的 ${name} 数组格式无效`);
        }
        const after = tokens[cursor + 1];
        if (after && !(after.t === 'sym' && after.v === ';')) throw new Error(`发布脚本的 ${name} 不能使用动态表达式`);
        result = values;
      }
      if (token.t === 'sym' && (token.v === '(' || token.v === '{' || token.v === '[')) depth++;
      else if (token.t === 'sym' && (token.v === ')' || token.v === '}' || token.v === ']')) depth = Math.max(0, depth - 1);
    }
    return result;
  }

  const BLOCKED_HOST_SUFFIXES = ['localhost', 'local', 'internal', 'home.arpa', 'huangguoai.ai'];

  function validDnsLabel(value) {
    return value.length >= 1 && value.length <= 63 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(value);
  }

  function validDnsName(value) {
    if (value.length > 253 || !value.includes('.')) return false;
    if (!value.split('.').every(validDnsLabel)) return false;
    if (BLOCKED_HOST_SUFFIXES.some(suffix => value === suffix || value.endsWith('.' + suffix))) return false;
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) return false; // 字面 IPv4
    return true;
  }

  function parseMirrors(js) {
    const tokens = jsTokens(js);
    const domains = jsArray(tokens, 'urls') || [];
    const subs = jsArray(tokens, 'subdomains') || [];
    if (!domains.length) throw new Error('发布脚本中没有找到镜像域名');
    const hosts = [];
    const seen = new Set();
    outer: for (const rawDomain of domains) {
      const domain = rawDomain.trim().replace(/\/+$/, '').toLowerCase();
      if (!validDnsName(domain)) continue;
      const candidates = subs.length
        ? subs.map(s => s.trim().toLowerCase()).filter(validDnsLabel).map(s => `${s}.${domain}`)
        : [domain];
      for (const host of candidates) {
        if (!validDnsName(host) || seen.has(host)) continue;
        seen.add(host);
        hosts.push(host);
        if (hosts.length >= MIRROR_MAX) break outer;
      }
    }
    if (!hosts.length) throw new Error('发布脚本中没有合法镜像地址');
    return hosts;
  }

  const originOf = url => {
    const match = /^https:\/\/([^\/?#]+)/i.exec(url);
    return match ? 'https://' + match[1].toLowerCase() : null;
  };

  /** 只接受发布页同源、文件名为 publish.js 的 HTTPS 脚本地址。 */
  function scriptSrc(page, html) {
    const re = /<script\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
    let match;
    while ((match = re.exec(html))) {
      const src = match[1] ?? match[2] ?? match[3];
      if (!src) continue;
      const trimmed = src.trim();
      if (/[\x00-\x1f\x7f]/.test(trimmed)) continue;
      const origin = originOf(page);
      if (!origin) continue;
      let path = null;
      if (/^https:\/\//i.test(trimmed)) {
        const parsed = /^https:\/\/([^\/?#]+)([^#]*)/i.exec(trimmed);
        if (!parsed || parsed[1].includes('@')) continue;
        if ('https://' + parsed[1].toLowerCase() !== origin) continue;
        path = parsed[2] || '/';
      } else if (trimmed.startsWith('//')) {
        continue; // 协议相对地址跨源，拒绝
      } else if (trimmed.startsWith('/')) {
        path = trimmed;
      } else {
        // 相对路径：按发布页目录解析（等同 URL join 的保守子集）
        const pagePath = page.slice(origin.length).split(/[?#]/)[0] || '/';
        const dir = pagePath.slice(0, pagePath.lastIndexOf('/') + 1);
        path = dir + (trimmed.startsWith('./') ? trimmed.slice(2) : trimmed);
      }
      if (path.includes('#') || path.includes('..')) continue;
      if (path.split('?')[0].split('/').pop() !== 'publish.js') continue;
      return origin + path;
    }
    throw new Error('地址发布页没有同源 publish.js 脚本');
  }

  async function mirrorsFromPage(page, ctx) {
    const pageRes = await hg.http.fetch({
      url: page,
      responseType: 'text',
      timeoutMs: timeoutMs(ctx, PAGE_TIMEOUT_MS),
      maxBytes: PAGE_MAX_BYTES,
      credentials: 'omit',
      signal: ctx.signal,
    });
    if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status}`);
    const pageOrigin = originOf(page);
    if (originOf(pageRes.url) !== pageOrigin) throw new Error('发布页跳转到了非可信地址');
    const script = scriptSrc(page, pageRes.data);
    const jsRes = await hg.http.fetch({
      url: script,
      responseType: 'text',
      timeoutMs: timeoutMs(ctx, PAGE_TIMEOUT_MS),
      maxBytes: PAGE_MAX_BYTES,
      credentials: 'omit',
      signal: ctx.signal,
    });
    if (!jsRes.ok) throw new Error(`HTTP ${jsRes.status}`);
    if (originOf(jsRes.url) !== pageOrigin) throw new Error('发布脚本跳转到了非可信地址');
    return parseMirrors(jsRes.data);
  }

  /** 两页结果交错去重；一个发布页失败不丢弃另一页。 */
  function mergeMirrors(lists) {
    const out = [];
    const seen = new Set([MAIN_HOST]);
    for (let index = 0; index < MIRROR_MAX; index++) {
      for (const list of lists) {
        if (index >= list.length) continue;
        const host = list[index];
        if (seen.has(host)) continue;
        seen.add(host);
        out.push(host);
        if (out.length >= MIRROR_MAX - 1) return out;
      }
    }
    return out;
  }

  const hostToEndpoint = host => ({ id: host, label: host, url: `https://${host}` });

  async function probeMirror(host, ctx, maximum) {
    const response = await hg.http.fetch({
      url: `https://${host}/api/videos`,
      query: { page: 1, size: 1 },
      responseType: 'json',
      timeoutMs: timeoutMs(ctx, maximum),
      signal: ctx.signal,
      credentials: 'omit',
      redirect: 'manual',
      maxBytes: PAGE_MAX_BYTES,
    });
    if (!response.ok) return false;
    const data = unwrap(response.data);
    return !!data && Array.isArray(data.items) && data.items.every(item => cardOf(item) !== null);
  }

  async function listEndpoints(params, ctx) {
    const fixed = [{ id: 'main', label: '主站（固定线路）', url: MAIN }];
    if (!params.refresh) {
      const cached = await hg.storage.get(ENDPOINTS_KEY);
      if (Array.isArray(cached) && cached.length) {
        return cached;
      }
    }
    const results = await Promise.allSettled(PUBLISH_PAGES.map(page => mirrorsFromPage(page, ctx)));
    const cancelled = results.find(r => r.status === 'rejected' && r.reason && r.reason.code === 'CANCELLED');
    if (cancelled) throw cancelled.reason;
    timeoutMs(ctx, PAGE_TIMEOUT_MS);
    const lists = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    const hosts = mergeMirrors(lists);
    if (!hosts.length) {
      const errors = results
        .filter(r => r.status === 'rejected')
        .map(r => String((r.reason && r.reason.message) || r.reason))
        .join('；');
      console.warn('[huanguo] 镜像刷新失败：', errors || '发布页无可用镜像');
      return fixed; // 无缓存且刷新失败时仍返回固定主站，保证列表非空
    }
    const probeBudget = ctx.deadline === null
      ? PROBE_TIMEOUT_MS
      : Math.min(PROBE_TIMEOUT_MS, Math.floor(ctx.deadline - Date.now()) - PROBE_RESERVE_MS);
    const candidates = hosts.slice(0, PROBE_MAX);
    const probes = probeBudget > 0
      ? await Promise.allSettled(candidates.map(host => probeMirror(host, ctx, probeBudget)))
      : [];
    const stopped = probes.find(r => r.status === 'rejected' && r.reason && r.reason.code === 'CANCELLED');
    if (stopped) throw stopped.reason;
    timeoutMs(ctx, PAGE_TIMEOUT_MS);
    const available = new Set(candidates.filter((host, i) => probes[i]?.status === 'fulfilled' && probes[i].value));
    const endpoints = hosts.filter(host => available.has(host)).map(hostToEndpoint)
      .concat(fixed, hosts.filter(host => !available.has(host)).map(hostToEndpoint));
    await hg.storage.set(ENDPOINTS_KEY, endpoints, { ttlSec: ENDPOINTS_TTL_SEC });
    return endpoints;
  }

  /* ───────── 数据映射 ───────── */

  function cardOf(v) {
    if (!v || typeof v !== 'object') return null;
    const numericId = Number(v.id !== undefined ? v.id : v.video_id);
    if (!Number.isInteger(numericId) || numericId <= 0) return null;
    const item = {
      id: String(numericId),
      title: str(v.title) || `作品 ${numericId}`,
      type: 'short',
    };
    const cover = imageRef(v.cover);
    if (cover) item.cover = cover;
    const description = str(v.description) || str(v.desc);
    if (description) item.description = description;
    if (Array.isArray(v.tags)) {
      const tags = v.tags.filter(t => typeof t === 'string' && t.trim()).slice(0, 20);
      if (tags.length) item.tags = tags;
    }
    const score = Number(v.score);
    if (Number.isFinite(score) && score > 0) item.score = Math.min(10, score);
    const count = int(v.episode_count);
    if (count > 0) item.episodeCount = count;
    const total = int(v.total_episodes);
    if (total > 0) item.totalEpisodes = total;
    if (v.is_finished === true || v.is_finished === 1) item.status = 'finished';
    else if (count > 0) item.status = 'ongoing';
    const counts = (v.counts && typeof v.counts === 'object') ? v.counts : {};
    const stats = {};
    const plays = int(v.hot) || int(v.metric_value) || int(counts.hot);
    if (plays > 0) stats.plays = plays;
    const likes = int(v.like_count) || int(counts.like);
    if (likes > 0) stats.likes = likes;
    const favorites = int(v.collect_count) || int(counts.collect);
    if (favorites > 0) stats.favorites = favorites;
    const comments = int(v.comment_count) || int(counts.comment);
    if (comments > 0) stats.comments = comments;
    if (Object.keys(stats).length) item.stats = stats;
    if (v.author && typeof v.author === 'object') {
      const authorId = Number(v.author.id);
      if (Number.isInteger(authorId) && authorId > 0) {
        const author = { id: String(authorId), name: str(v.author.name) || `作者 ${authorId}` };
        const avatar = imageRef(v.author.avatar);
        if (avatar) author.avatar = avatar;
        const followers = int(v.author.followers);
        if (followers > 0) author.followers = followers;
        item.author = author;
      }
    }
    return item;
  }

  function pageOf(data, mapper) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.items)) {
      throw new hg.PluginError('UPSTREAM_CHANGED', '上游列表结构已变化');
    }
    const items = data.items.map(mapper).filter(Boolean).slice(0, 100);
    const pagination = (data.pagination && typeof data.pagination === 'object') ? data.pagination : {};
    const page = Number(pagination.page) || 1;
    const pages = Number(pagination.pages) || 0;
    const out = { items, next: page < pages ? nextPage(page) : null };
    const total = Number(pagination.total);
    if (Number.isFinite(total) && total > 0) out.total = total;
    return out;
  }

  function episodesOf(data) {
    let raw = Array.isArray(data.episodes)
      ? data.episodes.filter(e => e && typeof e === 'object')
      : [];
    if (!raw.length) {
      const count = Math.min(int(data.episode_count), 5000);
      raw = Array.from({ length: count }, (_, index) => ({ ep_num: index + 1 }));
    }
    const episodes = [];
    const seen = new Set();
    for (const e of raw) {
      if (episodes.length >= 5000) break;
      const num = Number(e.ep_num);
      if (!Number.isInteger(num) || num <= 0 || seen.has(num)) continue;
      seen.add(num);
      const episode = { id: String(num), index: episodes.length + 1, episodeNumber: num, label: String(num) };
      const title = str(e.title);
      if (title) episode.title = title;
      const duration = Number(e.duration);
      if (Number.isFinite(duration) && duration > 0) episode.durationSec = duration;
      episodes.push(episode);
    }
    return episodes;
  }

  function commentOf(c) {
    if (!c || typeof c !== 'object') return null;
    const numericId = Number(c.id);
    if (!Number.isInteger(numericId) || numericId <= 0) return null;
    const text = str(c.text);
    if (!text) return null;
    const out = {
      id: String(numericId),
      author: { name: str(c.nickname) || '匿名' },
      text,
    };
    const avatar = imageRef(c.avatar);
    if (avatar) out.author.avatar = avatar;
    const likes = int(c.like_count);
    if (likes > 0) out.likes = likes;
    if (c.liked === true) out.liked = true;
    const replyCount = int(c.reply_count);
    if (replyCount > 0) out.replyCount = replyCount;
    if (c.is_pinned === true || c.is_pinned === 1) out.pinned = true;
    const region = str(c.ip_region);
    if (region) out.region = region;
    if (Array.isArray(c.reply_list)) {
      const replies = c.reply_list.map(commentOf).filter(Boolean).slice(0, 3);
      if (replies.length) out.replies = replies;
    }
    return out;
  }

  /* ───────── 能力：endpoints ───────── */

  const endpoints = { list: listEndpoints };

  /* ───────── 能力：home ───────── */

  async function getSections(params, ctx) {
    const latest = await apiGet(ctx, '/api/videos', { query: { page: 1, size: LIST_SIZE } });
    const sections = [];
    const latestItems = pageOf(latest, cardOf).items;
    if (latestItems.length) {
      sections.push({ id: 'latest', title: '最新上线', layout: 'row', items: latestItems, more: true });
    }
    try {
      const hot = await apiGet(ctx, '/api/ranks/hot');
      const hotList = Array.isArray(hot) ? hot : (hot && Array.isArray(hot.items) ? hot.items : []);
      const hotItems = hotList.map(cardOf).filter(Boolean).slice(0, LIST_SIZE);
      if (hotItems.length) sections.push({ id: 'hot', title: '热门榜单', layout: 'row', items: hotItems });
    } catch (error) {
      if (isControlError(error)) throw error;
      console.warn('[huanguo] 热门榜获取失败：', (error && error.message) || error);
    }
    if (!sections.length) throw new hg.PluginError('UPSTREAM_CHANGED', '首页数据不可用');
    return { items: sections, next: null };
  }

  async function listSection(params, ctx) {
    if (params.sectionId !== 'latest') throw new hg.PluginError('NOT_FOUND', '未知分区');
    const page = cursorPage(params);
    const data = await apiGet(ctx, '/api/videos', { query: { page, size: LIST_SIZE } });
    return pageOf(data, cardOf);
  }

  const home = { getSections, listSection };

  /* ───────── 能力：feed ───────── */

  async function feedList(params, ctx) {
    const page = cursorPage(params);
    const data = await apiGet(ctx, '/api/videos', { query: { page, size: LIST_SIZE } });
    const result = pageOf(data, cardOf);
    for (const item of result.items) item.entryEpisodeId = '1';
    return result;
  }

  const feed = { list: feedList };

  /* ───────── 能力：catalog ───────── */

  const CATEGORIES = [
    { id: 'all', label: '全部短剧' },
    { id: 'ai-duanju', label: 'AI 短剧' },
    { id: 'ai-manju', label: 'AI 漫剧' },
  ];
  const SORTS = [{ id: 'latest', label: '最新' }];

  function getCategories() {
    return CATEGORIES.map(category => ({ ...category, sorts: SORTS }));
  }

  async function catalogList(params, ctx) {
    const category = CATEGORIES.find(c => c.id === params.categoryId);
    if (!category) throw new hg.PluginError('NOT_FOUND', '未知分类');
    const page = cursorPage(params);
    const query = { page, size: LIST_SIZE };
    if (params.sort) query.sort = params.sort;
    const path = category.id === 'all' ? '/api/videos' : `/api/videos/category/${category.id}`;
    const data = await apiGet(ctx, path, { query });
    return pageOf(data, cardOf);
  }

  const catalog = { getCategories, list: catalogList };

  /* ───────── 能力：search ───────── */

  async function search(params, ctx) {
    const query = str(params.query);
    if (!query) return { items: [], next: null };
    const page = cursorPage(params);
    const data = await apiGet(ctx, '/api/search', { query: { q: query, type: 'video', page, size: LIST_SIZE } });
    return pageOf(data, cardOf);
  }

  const searchCapability = { search };

  /* ───────── 能力：media ───────── */

  async function getDetail({ id }, ctx) {
    const vid = Number(id);
    if (!Number.isInteger(vid) || vid <= 0) throw new hg.PluginError('INVALID_ARGUMENT', '无效的作品 ID');
    const data = await apiGet(ctx, `/api/videos/${vid}`);
    const item = cardOf(data);
    if (!item) throw new hg.PluginError('UPSTREAM_CHANGED', '详情结构已变化');
    const episodes = episodesOf(data);
    if (!episodes.length) throw new hg.PluginError('UPSTREAM_CHANGED', '分集信息缺失');
    const detail = { ...item, playlists: [{ id: 'main', kind: 'main', label: '正片', episodes }] };
    if (data.interaction && typeof data.interaction === 'object') {
      const interaction = {};
      if (data.interaction.liked === true) interaction.liked = true;
      if (data.interaction.collected === true) interaction.favorited = true;
      if (Object.keys(interaction).length) detail.interaction = interaction;
    }
    const created = str(data.created_at);
    if (created) {
      const ts = Date.parse(created);
      if (Number.isFinite(ts)) {
        detail.publishedAt = ts;
        detail.year = new Date(ts).getFullYear();
      }
    }
    return detail;
  }

  /** 与客户端 normalize_play_info 一致：streams.main/hevc 回填 video_url，缺 main 时用 hevc 兜底。 */
  function normalizePlay(info) {
    if (!info || typeof info !== 'object') return null;
    const streams = (info.streams && typeof info.streams === 'object') ? info.streams : {};
    const pick = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const main = pick(info.video_url) || pick(streams.main);
    const hevc = pick(info.video_url_hevc) || pick(streams.hevc);
    if (!main && !hevc) return null;
    return { main, hevc, duration: info.duration };
  }

  async function resolvePlayback(params, ctx) {
    const vid = Number(params.mediaId);
    const ep = Number(params.episodeId);
    if (!Number.isInteger(vid) || vid <= 0 || !Number.isInteger(ep) || ep <= 0) {
      throw new hg.PluginError('INVALID_ARGUMENT', '无效的作品或分集 ID');
    }
    let play = null;
    try {
      play = normalizePlay(await apiPost(ctx, `/api/videos/${vid}/episodes/${ep}/playback`));
    } catch (error) {
      if (error.code !== 'UNSUPPORTED') throw error;
    }
    if (!play) {
      play = normalizePlay(await apiGet(ctx, `/api/videos/${vid}/play`, { query: { ep, page_texts: 0 } }));
    }
    if (!play) throw new hg.PluginError('UPSTREAM_CHANGED', '上游没有返回可识别的播放地址');
    const candidates = [];
    if (play.main) candidates.push({ url: play.main, codec: 'h264', label: '标准' });
    if (play.hevc) candidates.push({ url: play.hevc, codec: 'hevc', label: 'HEVC' });
    const order = Array.isArray(params.codecs) ? params.codecs : [];
    candidates.sort((a, b) => {
      const ia = order.indexOf(a.codec);
      const ib = order.indexOf(b.codec);
      return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib);
    });
    const out = {
      streams: candidates.map(c => ({
        url: c.url,
        kind: 'media',
        format: 'hls',
        codec: c.codec,
        label: c.label,
      })),
    };
    const duration = Number(play.duration);
    if (Number.isFinite(duration) && duration > 0) out.durationSec = duration;
    return out;
  }

  const media = { getDetail, resolvePlayback };

  /* ───────── 能力：comments（只读） ───────── */

  async function commentsList(params, ctx) {
    const target = params.target;
    if (!target || target.kind !== 'media') throw new hg.PluginError('UNSUPPORTED', '仅支持作品评论');
    const vid = Number(target.mediaId);
    if (!Number.isInteger(vid) || vid <= 0) throw new hg.PluginError('INVALID_ARGUMENT', '无效的作品 ID');
    const ep = target.episodeId ? Number(target.episodeId) : 1;
    if (!Number.isInteger(ep) || ep <= 0) throw new hg.PluginError('INVALID_ARGUMENT', '无效的分集 ID');
    const page = cursorPage(params);
    const data = await apiGet(ctx, `/api/videos/${vid}/comments`, { query: { ep, page, size: LIST_SIZE } });
    return pageOf(data, commentOf);
  }

  const comments = { list: commentsList };

  return { endpoints, home, feed, catalog, search: searchCapability, media, comments };
};

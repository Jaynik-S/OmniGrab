import type { ManifestInfo } from '../core/model.ts';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { addReference, addVariant, checkText, positiveNumber, resolveHttp, uniqueReferences } from './shared.ts';

type Node = { [name: string]: string | Node | Node[] | undefined };
interface Context {
  base: string;
  explicitBase: boolean;
  metadata: Record<string, string>;
  descriptor?: { kind: string; node: Node };
}

function children(node: Node, name: string): Node[] {
  const value = node[name];
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map(child => typeof child === 'string' ? { '#text': child } : child);
}

function attribute(node: Node, name: string): string | undefined {
  const value = node[`@_${name}`];
  return typeof value === 'string' ? value : undefined;
}

function descend(node: Node, parent: Context): Context {
  const bases = children(node, 'BaseURL');
  if (bases.length > 1) throw new Error('Unsupported DASH multiple BaseURL alternatives');
  const baseText = bases[0]?.['#text'];
  if (bases.length && (typeof baseText !== 'string' || !baseText.trim())) throw new Error('Invalid DASH BaseURL');
  const metadata = { ...parent.metadata };
  for (const name of ['contentType', 'mimeType', 'codecs', 'width', 'height', 'lang', 'bandwidth']) {
    const value = attribute(node, name);
    if (value !== undefined) metadata[name] = value;
  }
  let descriptor = parent.descriptor;
  const forms = ['SegmentTemplate', 'SegmentList', 'SegmentBase'].flatMap(kind => children(node, kind).map(child => ({ kind, node: child })));
  if (forms.length > 1) throw new Error('Unsupported DASH multiple segment descriptors');
  if (forms[0]) {
    const form = forms[0];
    descriptor = { kind: form.kind, node: descriptor?.kind === form.kind ? { ...descriptor.node, ...form.node } : form.node };
  }
  return {
    base: typeof baseText === 'string' ? resolveHttp(baseText.trim(), parent.base) : parent.base,
    explicitBase: parent.explicitBase || !!bases.length,
    metadata, descriptor,
  };
}

function checkXml(text: string): void {
  // Literal XML text may contain raw ampersands and declaration-like strings.
  // Keep a separator so removing a literal section cannot join entity tokens.
  const entityText = text.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, ' ');
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(entityText)) throw new Error('DASH DTD/entity declarations are forbidden');
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(entityText)) throw new Error('Invalid DASH entity reference');
  let depth = 0;
  let nodes = 0;
  // Scan before parsing, so excessive nesting never reaches the recursive XML builder.
  const tags = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(?:[^>"']|"[^"]*"|'[^']*')*>/g;
  for (const [tag] of text.matchAll(tags)) {
    if (tag.startsWith('<?') || tag.startsWith('<!')) continue;
    if (tag.startsWith('</')) depth--;
    else {
      if (++nodes > 30_000) throw new Error('DASH XML node limit exceeded');
      if (++depth > 64) throw new Error('DASH XML depth limit exceeded');
      if (/\/\s*>$/.test(tag)) depth--;
    }
  }
  const valid = XMLValidator.validate(text);
  if (valid !== true) throw new Error(`Malformed DASH XML: ${valid.err.msg}`);
}

function isoDuration(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!match || !match.slice(1).some(Boolean)) throw new Error('Unsupported DASH duration');
  const duration = Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0);
  if (!Number.isFinite(duration)) throw new Error('Invalid DASH duration');
  return duration;
}

/** Preserve only concrete references: templates requiring timeline/number expansion are not URLs. */
function templateReference(value: string, id: string | undefined, bandwidth: string | undefined): string | undefined {
  let result = value;
  if (id !== undefined) result = result.replaceAll('$RepresentationID$', id);
  if (bandwidth !== undefined) result = result.replaceAll('$Bandwidth$', bandwidth);
  if (/\$(?!\$)/.test(result.replaceAll('$$', ''))) return undefined;
  return result.replaceAll('$$', '$');
}

function segments(info: ManifestInfo, context: Context, id: string | undefined): void {
  const descriptor = context.descriptor;
  if (!descriptor) return;
  const record = (value: string | undefined) => {
    if (value) addReference(info.segmentUrls, resolveHttp(value, context.base));
  };
  if (descriptor.kind === 'SegmentTemplate') {
    for (const name of ['initialization', 'media']) {
      const value = attribute(descriptor.node, name);
      if (value) record(templateReference(value, id, context.metadata.bandwidth));
    }
  } else {
    for (const init of children(descriptor.node, 'Initialization')) record(attribute(init, 'sourceURL'));
    for (const segment of children(descriptor.node, 'SegmentURL')) {
      record(attribute(segment, 'media'));
      record(attribute(segment, 'index'));
    }
  }
}

export function parseDash(text: string, baseUrl: string): ManifestInfo {
  checkText(text);
  checkXml(text);
  const parsed = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, parseAttributeValue: false, ignoreDeclaration: true, ignorePiTags: true }).parse(text) as Node;
  if (Object.keys(parsed).length !== 1 || !parsed.MPD || typeof parsed.MPD === 'string' || Array.isArray(parsed.MPD)) throw new Error('DASH MPD root required');
  const mpd = parsed.MPD;
  const type = attribute(mpd, 'type');
  if (type && type !== 'dynamic' && type !== 'static') throw new Error('Invalid DASH MPD type');
  const info: ManifestInfo = { type: 'dash', variants: [], childUrls: [], segmentUrls: [], live: type === 'dynamic', protected: false, duration: isoDuration(attribute(mpd, 'mediaPresentationDuration')) };
  const initial = descend(mpd, { base: resolveHttp(baseUrl, baseUrl), explicitBase: false, metadata: {} });
  const protectedAt = (node: Node) => { if (children(node, 'ContentProtection').length) info.protected = true; };
  protectedAt(mpd);
  for (const period of children(mpd, 'Period')) {
    const periodContext = descend(period, initial);
    protectedAt(period);
    for (const adaptation of children(period, 'AdaptationSet')) {
      const adaptationContext = descend(adaptation, periodContext);
      protectedAt(adaptation);
      for (const representation of children(adaptation, 'Representation')) {
        const context = descend(representation, adaptationContext);
        const metadata = context.metadata;
        const representationId = attribute(representation, 'id');
        const contentType = metadata.contentType ?? metadata.mimeType?.split('/')[0];
        const kind = contentType === 'audio' ? 'audio' : contentType === 'video' ? 'video' : contentType === 'text' || contentType === 'subtitles' || /(?:ttml|vtt|stpp|wvtt)/i.test(`${metadata.mimeType ?? ''} ${metadata.codecs ?? ''}`) ? 'subtitles' : undefined;
        protectedAt(representation);
        addVariant(info, {
          id: `dash:${info.variants.length}`, representationId, kind,
          url: context.explicitBase ? context.base : undefined,
          bandwidth: positiveNumber(metadata.bandwidth, 'DASH bandwidth'),
          width: positiveNumber(metadata.width, 'DASH width'), height: positiveNumber(metadata.height, 'DASH height'),
          codecs: metadata.codecs, language: metadata.lang, group: attribute(adaptation, 'id'),
        });
        segments(info, context, representationId);
      }
    }
  }
  if (!info.variants.length) throw new Error('Unsupported DASH MPD without representations');
  return uniqueReferences(info);
}

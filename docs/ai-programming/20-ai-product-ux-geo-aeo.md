# Capítulo 20 — UX de productos IA + GEO/AEO

> **Focus:** Diseñar productos IA que la gente confie (human-in-the-loop, confidence, error handling) + GEO/AEO: cómo tu página sale primero cuando alguien pregunta a una IA.
> **Áreas:** UX productos IA · GEO/AEO · Nuevas prácticas de dev
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 25 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- HTML/CSS básico, JavaScript moderno (ES2022+, fetch, AbortController).
- Conceptos básicos de SEO tradicional (crawl, index, rank).
- Nociones de RAG y evals (ver [cap 09 — evals & LLM-as-judge](./09-evals-datasets-llm-judge.md)).
- Fundamentos de seguridad y prompt injection (ver [cap 11 — OWASP LLM Top 10](./11-prompt-injection-owasp-llm.md)).
- Ideal: leer previamente [cap 19 — data pipelines + PII + EU AI Act](./19-data-pipelines-pii-eu-ai-act.md) para el contexto regulatorio de Art. 50.

**Glosario mínimo:**
- **GEO** (Generative Engine Optimization): práctica de estructurar contenido para que sea **citado** por motores generativos (ChatGPT Search, Perplexity, Google AI Overviews).
- **AEO** (Answer Engine Optimization): término casi sinónimo de GEO, con énfasis en formatos pregunta/respuesta.
- **LLM crawler**: bot que descarga contenido web para entrenar modelos (GPTBot, ClaudeBot, CCBot) o para indexar respuestas en tiempo real (OAI-SearchBot, PerplexityBot).
- **llms.txt**: propuesta de convención (Jeremy Howard, Answer.AI, sept 2024) de archivo Markdown en la raíz que ofrece un índice curado del sitio para agentes LLM.
- **schema.org**: vocabulario compartido para structured data. Se serializa normalmente como JSON-LD.
- **JSON-LD**: formato de linked data embebido en `<script type="application/ld+json">` que los crawlers parsean para extraer entidades.
- **HITL** (human-in-the-loop): patrón donde un humano aprueba, edita o corrige la salida del modelo antes de que tenga efecto.
- **Confidence indicator**: elemento de UI que expresa cuán seguro está el modelo (badge, texto, barra) para calibrar la confianza del usuario.
- **Hallucination hijacking**: contenido de un competidor que manipula la narrativa que los modelos construyen sobre tu marca.

**Setup mínimo:**

```bash
# 1. Ver tu sitio como lo ve ChatGPT (GPTBot user agent)
curl -A "GPTBot/1.0 (+https://openai.com/gptbot)" \
     -o gptbot-view.html \
     https://tusitio.com

# 2. Ver como lo ve PerplexityBot
curl -A "PerplexityBot/1.0 (+https://perplexity.ai/perplexitybot)" \
     -o perplexitybot-view.html \
     https://tusitio.com

# 3. Comparar con Googlebot
curl -A "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" \
     -o googlebot-view.html \
     https://tusitio.com

# 4. Diff rápido para ver diferencias de rendering
diff <(cat gptbot-view.html | grep -oE '<h[1-3][^>]*>[^<]*') \
     <(cat googlebot-view.html | grep -oE '<h[1-3][^>]*>[^<]*')

# 5. Utilidades de dev
npm i -D schema-dts             # tipos TypeScript de schema.org
npm i @vercel/analytics posthog-js   # tracking incluyendo referrers de IA
npx @schema-dts/cli validate ./page.jsonld   # validar JSON-LD
```

---

## 1. El gran cuadro

Los productos con IA rompen tres suposiciones que la UX web tradicional daba por sentadas: **determinismo**, **latencia predecible** y **corrección**. Un botón "Guardar" siempre guarda. Un endpoint REST responde en 200 ms o en 5 s, pero devuelve lo mismo con las mismas entradas. Un LLM, en cambio, puede tardar 200 ms o 45 s, generar cinco respuestas distintas al mismo prompt, y alucinar hechos que parecen ciertos. Diseñar para este mundo requiere patrones específicos: **calibrated confidence**, **progressive disclosure**, **stop buttons obligatorios**, **citations verificables**, **HITL por default en acciones consecuentes**. La ausencia de estos patrones no es "mala UX" en abstracto: es la causa directa de casos como Air Canada perdiendo un juicio en 2024 porque su chatbot inventó una política de reembolso, o de Klarna recontratando humanos tras el fracaso de su bot autónomo.

El segundo cambio de paradigma es la **distribución del descubrimiento**. Durante veinte años, "estar en Google" fue sinónimo de existir en internet. Desde 2023, cuando ChatGPT alcanzó los cien millones de usuarios en meses, y sobre todo desde el lanzamiento de **ChatGPT Search** (oct 2024), **Perplexity** (2023+), **Google AI Overviews** (may 2024) y **Copilot** con browsing (2023), una porción creciente de queries no termina en un click a tu sitio, sino en una **respuesta sintetizada** que puede citarte, no citarte, o peor: mencionar ventajas de tu competidor. El fenómeno "zero-click" —el usuario obtiene su respuesta en la interfaz de IA sin visitarte— es medible y crece cada trimestre. La disciplina que responde a esto se llama **GEO** (Generative Engine Optimization) o **AEO** (Answer Engine Optimization), y aunque comparte suelo con SEO, tiene técnicas y objetivos propios.

El tercer factor es regulatorio. La **EU AI Act** entró en vigor en agosto de 2024 con aplicación escalonada; el **Artículo 50** (obligaciones de transparencia: chatbots deben identificarse como IA, contenido sintético debe marcarse) es aplicable desde **2 de agosto de 2026**, con multas de hasta **15 M EUR o 3% del turnover global**. En Estados Unidos, la FTC ha emitido guías sobre publicidad engañosa con IA (2023-2024). Casos como *Air Canada v Moffatt* (2024, BCCRT) han establecido que las empresas son legalmente responsables por lo que dice su chatbot. Diseñar UX de IA en 2026 sin considerar transparencia, disclosure y auditabilidad es exponerse a multas y demandas.

El impacto acumulado es claro: los productos que no adoptan patrones UX específicos de IA pierden confianza tras el primer error visible; los sitios que no adoptan prácticas GEO se vuelven invisibles en la nueva capa de descubrimiento; y las empresas que no cumplen la EU AI Act enfrentan sanciones desde agosto de 2026. Este capítulo cubre las tres áreas y termina con ejercicios prácticos aplicables al proyecto **LinguaDev Pro**.

---

## 2. Fundamentos UX de productos IA (nivel básico)

**Analogía útil.** GEO es "**SEO para motores de respuesta**": donde SEO optimizaba la posición del enlace en una SERP de 10 resultados, GEO optimiza tu probabilidad de ser *citado* en la respuesta sintetizada de ChatGPT, Perplexity o Google AI Overviews. Muchas técnicas SEO clásicas siguen siendo válidas (schema.org, contenido de calidad, backlinks), pero se añaden capas nuevas: `llms.txt`, permisos por crawler, contenido citation-worthy y semantic HTML machine-parseable.

### 2.1 Diseñar para la incertidumbre

Un LLM produce texto con probabilidad, no con certeza. Ocultar esa incertidumbre erosiona la confianza cuando —inevitablemente— aparecen errores. Los patrones establecidos son:

- **Confidence indicators**: badges tipo `high/medium/low`, termómetros o texto ("modelo poco seguro"). Cuando el retriever devuelve pocos chunks relevantes o el `logprob` del token es bajo, expone esa información al usuario.
- **Hedging language calibrado**: "parece que", "según *X*", "no encontré fuentes fiables sobre esto". No es debilidad; es honestidad.
- **Source citations obligatorias** en respuestas RAG (ver §2.5).
- **Graceful "I don't know"** con handoff a humano en lugar de fabricar.

Ejemplo mínimo en React:

```tsx
// components/AnswerWithConfidence.tsx
type Confidence = 'high' | 'medium' | 'low';

interface AnswerProps {
  text: string;
  confidence: Confidence;
  sources: Array<{ url: string; title: string; snippet: string }>;
  onEscalate: () => void;
}

export function AnswerWithConfidence({ text, confidence, sources, onEscalate }: AnswerProps) {
  const label = { high: 'Alta confianza', medium: 'Confianza media', low: 'Baja confianza' }[confidence];
  const color = { high: 'bg-green-100', medium: 'bg-yellow-100', low: 'bg-red-100' }[confidence];

  return (
    <article className="rounded-xl border p-4">
      <div className={`inline-flex items-center gap-2 rounded px-2 py-1 text-xs ${color}`}>
        <span aria-hidden>*</span>
        <span>{label}</span>
      </div>
      <p className="mt-3 leading-relaxed">{text}</p>

      {sources.length > 0 && (
        <ol className="mt-4 space-y-1 text-sm">
          {sources.map((s, i) => (
            <li key={s.url}>
              <a href={s.url} target="_blank" rel="noreferrer" className="underline">
                [{i + 1}] {s.title}
              </a>
              <span className="text-gray-600"> — {s.snippet}</span>
            </li>
          ))}
        </ol>
      )}

      {confidence === 'low' && (
        <button
          onClick={onEscalate}
          className="mt-4 rounded bg-blue-600 px-3 py-2 text-sm text-white"
        >
          Hablar con un humano
        </button>
      )}
    </article>
  );
}
```

Este componente aplica cuatro principios en cincuenta líneas: badge de confianza, texto, citations numeradas verificables y handoff cuando la confianza es baja.

**Desglose paso a paso de por qué cada elemento importa:**

1. **Badge de confianza visual**: usuarios calibran su verificación en función del badge. Verde → menos escrutinio; rojo → doble-check obligatorio. Sin badge, todo se lee con el mismo peso (y los errores dañan igual).
2. **Texto conciso primero**: la respuesta antes que las fuentes; el usuario decide si profundiza.
3. **Citations numeradas `[1] [2]`**: patrón Perplexity de 2023, ahora estándar. Numeradas permiten referencia inline en el texto (`"según [1] el compuesto..."`).
4. **Verificabilidad**: `target="_blank" rel="noreferrer"` para que abrir la fuente no pierda el contexto de conversación.
5. **Handoff condicional**: solo mostrar el botón "hablar con humano" cuando la confianza es baja, no siempre; evita fatiga y comunica el signal correcto.

### 2.2 Human-in-the-loop: los cinco patrones

HITL no es binario "aprobar / no aprobar". La taxonomía útil, alineada con el **Google PAIR Guidebook** y las **Microsoft Human-AI Interaction Guidelines** (Amershi et al. 2019, 18 reglas), es:

| Patrón | Cuándo usarlo | Ejemplo |
|---|---|---|
| **Fully autonomous** | Acción reversible, low-stakes, alto volumen | Filtro anti-spam clasificando mails |
| **Approve-then-act** | Acción con efectos externos (mail, pago, deploy) | Bot que borra tickets: humano confirma |
| **Edit-then-submit** | Creación de contenido con velocidad + safety | Copilot sugiere código; el dev lo edita |
| **Suggest-only** | Decisiones que requieren juicio humano | AI sugiere 3 candidatos; humano decide |
| **Undo window** | Acción asíncrona con posibilidad de revertir | Gmail "Undo send" 30 s |

La elección depende de **reversibilidad** y **blast radius** (a cuántos usuarios/sistemas afecta un fallo). Anti-patrón clásico: *approval theater*, cuando el humano hace clic en "aprobar" sin leer por *automation bias*. La UI debe forzar micro-fricción cognitiva (mostrar diff, resaltar cambios peligrosos) en acciones consecuentes.

**Mini-código: patrón edit-then-submit con diff visual en 12 líneas:**

```tsx
function AiDraft({ original, aiRewrite, onSubmit }) {
  const [text, setText] = useState(aiRewrite);
  const diff = text !== aiRewrite ? " (editado)" : "";
  return (
    <div>
      <details><summary>Ver original</summary><pre>{original}</pre></details>
      <textarea value={text} onChange={e => setText(e.target.value)} rows={8} />
      <p>{text.length} caracteres{diff}</p>
      <button onClick={() => onSubmit(text)}>Enviar mi versión</button>
    </div>
  );
}
```

El usuario ve la versión IA como *punto de partida*, no como decisión final. Notion AI popularizó este patrón en 2023.

### 2.3 Progressive disclosure: streaming y thinking

Nielsen Norman estableció límites de respuesta: **0.1 s** es instantáneo, **1 s** mantiene el foco, **10 s** es el límite antes del abandono. Un LLM sin streaming supera los 10 s con facilidad. El patrón obligatorio es:

- **Streaming de tokens** vía Server-Sent Events (SSE) o WebSocket. Reduce la latencia percibida drásticamente aunque la latencia real no cambie.
- **Thinking visible** (introducido por o1 en sep 2024, Claude 3.7 en 2025): mostrar el reasoning intermedio en un bloque colapsable para tasks complejas. Aumenta trust; útil para debugging.
- **Staged progress** para agentes multi-step: "buscando docs… encontré 5… generando resumen…".

Cliente SSE mínimo:

```ts
// lib/streaming.ts
export async function streamChat(prompt: string, onToken: (t: string) => void, signal: AbortSignal) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
    signal, // para el stop button
  });

  if (!response.ok || !response.body) throw new Error('Stream failed');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split('\n')) {
      if (line.startsWith('data: ')) {
        const payload = line.slice(6);
        if (payload === '[DONE]') return;
        try {
          const { delta } = JSON.parse(payload);
          if (delta) onToken(delta);
        } catch { /* mensaje de keep-alive */ }
      }
    }
  }
}
```

### 2.4 Stop button obligatorio

Nielsen Heurística #3: *user control and freedom*. Un chatbot sin botón de stop que fuerza al usuario a esperar 30 s de respuesta obviamente mala es un defecto de UX. La implementación con `AbortController` es trivial:

```tsx
// components/Chat.tsx
import { useRef, useState } from 'react';
import { streamChat } from '../lib/streaming';

export function Chat() {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  async function send(prompt: string) {
    setAnswer('');
    setBusy(true);
    abortRef.current = new AbortController();
    try {
      await streamChat(prompt, (t) => setAnswer((a) => a + t), abortRef.current.signal);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') console.error(e);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  return (
    <div>
      <pre>{answer}</pre>
      {busy && (
        <button
          onClick={() => abortRef.current?.abort()}
          className="rounded bg-red-600 px-3 py-2 text-white"
          aria-label="Detener generación"
        >
          Stop
        </button>
      )}
    </div>
  );
}
```

Para agentes con tool calls, el stop debe además interrumpir tools *en vuelo* (importante con acciones irreversibles: diseño transaccional o puntos de interrupción "safe").

### 2.5 Attribution y citations

En productos RAG, mostrar sources es non-negotiable por cuatro razones: (1) **verificabilidad** —el usuario puede confirmar—, (2) **trust** —fuentes visibles son responsables—, (3) **legal** —a veces la atribución es requerida (contenido noticioso, académico)—, (4) **ecosistema** —enviar tráfico a las fuentes mantiene el ciclo virtuoso donde los publishers siguen produciendo contenido citable. Perplexity estableció el patrón moderno en 2023 (números inline con hover, panel lateral, quote highlighting). ChatGPT Search adoptó fuentes obligatorias en oct 2024. Anti-patrones: citations sin link verificable, URLs alucinadas por el LLM (deben validarse antes de mostrar).

---

## 3. Cómo funciona GEO/AEO por dentro (nivel medio)

### 3.1 Los crawlers de IA en 2026

Cada vendor publica su user-agent y su propósito. La lista relevante:

| User-Agent | Vendor | Propósito |
|---|---|---|
| `GPTBot` | OpenAI | Training del modelo base |
| `ChatGPT-User` | OpenAI | Browsing on-behalf del usuario |
| `OAI-SearchBot` | OpenAI | Index para ChatGPT Search |
| `ClaudeBot` | Anthropic | Training |
| `claude-web` | Anthropic | Browsing on-behalf |
| `Google-Extended` | Google | Training de Bard/Gemini (independiente de Googlebot) |
| `PerplexityBot` | Perplexity | Indexing para búsqueda |
| `CCBot` | Common Crawl | Corpus del que se alimentan muchos modelos |
| `Bytespider` | ByteDance | Training |
| `Applebot-Extended` | Apple | Training para Apple Intelligence |
| `Meta-ExternalAgent` | Meta | Training para Meta AI |
| `DuckAssistBot` | DuckDuckGo | Asistente DuckAssist |

**Nota:** `anthropic-ai` está deprecated en 2026; usa `ClaudeBot`.

### 3.2 Estrategia por crawler

La decisión "permitir vs bloquear" **no es blanket**: se toma por crawler según objetivo comercial.

- **Permitir crawlers de búsqueda** (`OAI-SearchBot`, `PerplexityBot`, `ChatGPT-User`) si quieres tráfico referral.
- **Bloquear crawlers de training** (`GPTBot`, `ClaudeBot`, `CCBot`, `Google-Extended`) si tu contenido es premium/paywalled y no quieres alimentar modelos sin acuerdo.
- **Monitorear** con logs y con productos como **Cloudflare AI Audit** (2024) que ofrece one-click block.

`robots.txt` de ejemplo:

```txt
# robots.txt — política mixta: allow búsqueda, block training
# Última actualización: 2026-08-13

# Bloquear training crawlers
User-agent: GPTBot
Disallow: /

User-agent: ClaudeBot
Disallow: /

User-agent: CCBot
Disallow: /

User-agent: Google-Extended
Disallow: /

User-agent: Bytespider
Disallow: /

User-agent: Applebot-Extended
Disallow: /

# Permitir crawlers de búsqueda en tiempo real
User-agent: OAI-SearchBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: PerplexityBot
Allow: /

# Default para el resto
User-agent: *
Allow: /

Sitemap: https://tusitio.com/sitemap.xml
```

Middleware Node/Edge para inspección y logging server-side:

```ts
// middleware.ts (Next.js Edge)
import { NextRequest, NextResponse } from 'next/server';

const AI_BOTS = [
  { name: 'GPTBot', purpose: 'training' },
  { name: 'OAI-SearchBot', purpose: 'search' },
  { name: 'ChatGPT-User', purpose: 'browsing' },
  { name: 'ClaudeBot', purpose: 'training' },
  { name: 'claude-web', purpose: 'browsing' },
  { name: 'PerplexityBot', purpose: 'search' },
  { name: 'Google-Extended', purpose: 'training' },
  { name: 'CCBot', purpose: 'training' },
  { name: 'Bytespider', purpose: 'training' },
];

export function middleware(req: NextRequest) {
  const ua = req.headers.get('user-agent') ?? '';
  const bot = AI_BOTS.find((b) => ua.includes(b.name));

  if (bot) {
    // Log para observabilidad de qué bots visitan
    console.log(JSON.stringify({
      event: 'ai_crawler_visit',
      bot: bot.name,
      purpose: bot.purpose,
      path: req.nextUrl.pathname,
      ts: new Date().toISOString(),
    }));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|favicon.ico).*)'],
};
```

### 3.3 llms.txt: la propuesta de Jeremy Howard

Presentada por **Jeremy Howard (Answer.AI)** en sept 2024, `llms.txt` es un archivo Markdown en la raíz (`/llms.txt`) con un índice curado del sitio para agentes LLM. Similar en espíritu a `robots.txt` pero con propósito opuesto: en vez de "no entres aquí", dice "aquí está lo importante". El formato canónico:

```markdown
# LinguaDev Pro

> PWA + backend serverless para pasar de A2 a B2/C1 en inglés con IA.
> Enfoque en active recall, FSRS y feedback estructurado.

## Documentación

- [Empezar en 5 min](https://linguadev.app/docs/getting-started.md): setup local y primer ejercicio.
- [Arquitectura](https://linguadev.app/docs/architecture.md): monorepo pnpm, AWS Lambda, DynamoDB, IndexedDB.
- [Motor de repetición](https://linguadev.app/docs/fsrs.md): implementación de FSRS-6.

## Guías tecnológicas

- [Módulo AI-Programming](https://linguadev.app/docs/ai-programming/README.md): 20 capítulos sobre construir productos con LLMs.

## Optional

- [Roadmap 2026](https://linguadev.app/roadmap.md)
- [Cambios recientes](https://linguadev.app/changelog.md)
```

**Estado 2026:** no es un standard oficial (no W3C/IETF). Ningún vendor confirma públicamente que lo honre. Sin embargo, la adopción crece (Anthropic, Cloudflare, Perplexity, Cursor, muchas SaaS) y `llmstxt.org` lista miles de adopters. Coste bajo, upside plausible.

**Convención complementaria:** publicar cada página en `.md` limpio bajo el sufijo `.md` (`/docs/foo.html` → `/docs/foo.html.md`), para que los agentes obtengan Markdown parseable sin ruido HTML.

### 3.4 Schema.org / JSON-LD

Los crawlers de IA (como los de búsqueda tradicional) extraen entidades estructuradas con **schema.org**. En 2026 lo relevante para GEO son:

- **Article**, **NewsArticle** — para blog, noticias.
- **FAQPage** — bloques Q&A muy fáciles de citar por LLMs.
- **HowTo** — guías paso a paso.
- **Product**, **Offer**, **Review** — e-commerce.
- **Organization**, **Person** — entity resolution (importante para que el modelo sepa quién eres).
- **BreadcrumbList** — jerarquía navegacional.

Ejemplo completo de `FAQPage` en JSON-LD:

```html
<!DOCTYPE html>
<html lang="es">
<head>
  <title>FAQ — LinguaDev Pro</title>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
      {
        "@type": "Question",
        "name": "¿Qué es LinguaDev Pro?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "LinguaDev Pro es una PWA con backend serverless en AWS que ayuda a devs hispanohablantes a pasar de A2 a B2/C1 en inglés. Usa active recall, FSRS y feedback estructurado con LLMs."
        }
      },
      {
        "@type": "Question",
        "name": "¿Cómo funciona el motor de repetición?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Implementa el algoritmo FSRS-6 (Free Spaced Repetition Scheduler). Cada review actualiza los parámetros stability y difficulty por tarjeta, y calcula la siguiente fecha óptima."
        }
      },
      {
        "@type": "Question",
        "name": "¿Necesito conexión a internet?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "No para las reviews básicas. El PWA usa IndexedDB para storage offline y sincroniza con DynamoDB cuando hay red. Las evaluaciones con LLM sí requieren conexión."
        }
      }
    ]
  }
  </script>
</head>
<body>
  <h1>Preguntas frecuentes</h1>
  <section>
    <h2>¿Qué es LinguaDev Pro?</h2>
    <p>LinguaDev Pro es una PWA con backend serverless en AWS…</p>
  </section>
  <!-- resto del contenido HTML paralelo al JSON-LD -->
</body>
</html>
```

**Regla dura:** el contenido del JSON-LD debe coincidir con el contenido HTML visible. Google penaliza (y presumiblemente los LLMs de-priorizan) discrepancias que huelen a *cloaking*.

### 3.5 Semantic HTML y por qué el rendering JS-only falla

Los crawlers de IA en 2026 son heterogéneos en su capacidad de ejecutar JavaScript:

- **Googlebot** ejecuta JS (Chromium headless) pero con delay y ocasionales fallos.
- **GPTBot** y **ClaudeBot** históricamente **no ejecutan JS** o lo hacen limitadamente; leen HTML plano.
- **PerplexityBot** parcialmente.
- **CCBot** no ejecuta JS.

Consecuencia: si tu SPA renderiza contenido solo con `useEffect` post-hydration, gran parte de los crawlers ven una página en blanco. Soluciones:

- **SSR** (Next.js `app/`, Nuxt, Remix, Astro con islands): HTML llega con contenido.
- **SSG** (Astro, Hugo, Eleventy, Next.js `next export`): HTML pre-generado.
- **ISR** (Next.js incremental static regeneration): mezcla.

Usa **HTML semántico** (`<article>`, `<section>`, `<h1>–<h6>`, `<table>`, `<ul>`, `<figure>`) porque los parsers construyen estructuras jerárquicas que hacen el texto extraíble como bloques citables. Evita tablas como imágenes, encabezados hechos con `<div>` estilizado, y muros de texto sin subdivisiones.

### 3.6 Bajo el capó: cómo un motor generativo decide a quién citar

Cuando escribes en Perplexity "¿qué es FSRS?", por dentro pasan cinco fases. Visualización:

```
Usuario          Perplexity backend                       Web
   │                    │                                  │
   │ "qué es FSRS?"     │                                  │
   │──────────────────▶│                                   │
   │                   │ 1. Query rewrite (LLM)            │
   │                   │    → "free spaced repetition      │
   │                   │       scheduler algorithm"        │
   │                   │                                   │
   │                   │ 2. Web search (Bing/Google API)   │
   │                   │──────────────────────────────────▶│
   │                   │◀──────────────────────────────────│
   │                   │    (top 20 URLs)                  │
   │                   │                                   │
   │                   │ 3. Fetch + parse (crawler)        │
   │                   │──────────────────────────────────▶│
   │                   │◀──────────────────────────────────│
   │                   │    (HTML, JSON-LD, texto)         │
   │                   │                                   │
   │                   │ 4. Rerank por relevance + trust   │
   │                   │    - domain authority             │
   │                   │    - freshness (dateModified)     │
   │                   │    - structured data richness     │
   │                   │    - E-E-A-T signals              │
   │                   │    - contradiction detection      │
   │                   │                                   │
   │                   │ 5. LLM synthesizes con top-K      │
   │                   │    (usualmente K=3-5)             │
   │                   │    citations = URLs incluidas     │
   │                   │                                   │
   │◀──────────────────│                                   │
   │  respuesta +      │                                   │
   │  citas [1][2][3]  │                                   │
```

**Por qué GEO importa en cada fase:**

- **Fase 1 (query rewrite)**: si tu página no menciona los sinónimos que el LLM usa para reescribir, no apareces en fase 2. Usa lenguaje natural + jerga técnica juntos ("FSRS (Free Spaced Repetition Scheduler)").
- **Fase 3 (fetch + parse)**: si tu página es SPA JS-only, el crawler ve `<div id="root"></div>`. Adiós. SSR/SSG es prerequisito.
- **Fase 4 (rerank)**: schema.org y llms.txt son señales estructurales; domain authority es señal externa; freshness castiga contenido sin `dateModified`.
- **Fase 5 (synthesize)**: el LLM prefiere fuentes con quotes citables cortas y factos numerados. Long-form estructurado > listicles vagos.

**Consecuencia práctica.** Ranquear #1 en Google no garantiza ser citado. Los rerankers de Perplexity/ChatGPT priorizan señales distintas (freshness > backlinks, por ejemplo). Optimizar solo para SEO clásico deja dinero encima de la mesa en 2026.

### 3.7 Tabla comparativa extendida: técnicas SEO vs GEO en 2026

| Técnica | SEO clásico | GEO / AEO | Notas 2026 |
|---|---|---|---|
| Keyword targeting | Alta prioridad | Media | LLMs razonan sobre intent, no matchean literal |
| Backlinks | Muy alta | Media-baja | Menos peso en Perplexity que Google |
| Domain authority | Alta | Alta | Sigue siendo trust signal fuerte |
| Freshness (`dateModified`) | Media | Muy alta | LLMs castigan contenido stale |
| Structured data (schema.org) | Media | Muy alta | Especialmente FAQPage y HowTo |
| Semantic HTML | Media | Muy alta | Sin esto, el chunker rompe párrafos |
| llms.txt | N/A | Emergente | Coste bajo, upside plausible |
| SSR/SSG | Media | Obligatoria | GPTBot/ClaudeBot no ejecutan JS |
| Long-form (>2k palabras) | Media | Alta | Más "quote surface" para el LLM |
| Numeric facts | Baja | Muy alta | LLMs adoran citas con números concretos |
| Q&A format explícito | Media | Muy alta | Mapea directo a FAQPage schema |
| Comparison content | Media | Alta | Muy citado cuando comparativa honesta |
| Robots.txt granular | Media | Alta | Decidir por crawler, no blanket |
| Contenido único (no rehash) | Alta | Muy alta | LLMs deduplican; contenido común no aporta |

En 2026, invertir 100% en SEO clásico y 0% en GEO es dejar 20-40% de tráfico potencial descubierto por LLMs sin cubrir.

---

## 4. Práctica avanzada UX + GEO (nivel senior)

### 4.1 Patrones UX de productos referentes

**Notion AI**: edit-then-submit por defecto. Muestra el borrador inline con highlight; usuario acepta, edita o descarta. Confidence implícito por el hecho de que siempre requiere aceptación.

**Linear AI**: suggest-only para issues. AI propone breakdown de un ticket en subtickets; el user marca cuáles quiere crear. Nunca acción autónoma.

**Cursor**: streaming agresivo + diff visual en el editor. Cada cambio se aplica como diff aceptable/rechazable; Ctrl+Z / Cmd+Z revierte. Sistema de checkpoints en modo Composer.

**ChatGPT Search / Perplexity**: staged progress ("searching web… reading 8 sources…"), citations inline numeradas, quote highlighting cuando se hace hover.

**Claude.ai con Artifacts** (2024+): separa la respuesta conversacional del artefacto (código, doc, componente) para que el user pueda iterar sobre el artefacto sin perder el chat.

### 4.2 Anti-dark-patterns y EU AI Act Art. 50

El **Artículo 50** de la EU AI Act (aplicable **2 de agosto de 2026**) obliga:

1. **Chatbots:** los operadores deben informar al usuario que está interactuando con IA, salvo que sea "obvio por el contexto". Formato: **claro, distinguible, accesible** al inicio de la interacción.
2. **Contenido sintético** (imagen, video, audio, texto tipo deepfake): marcado **machine-readable** (watermark, metadatos tipo C2PA) + label **human-perceptible**.
3. **Sistemas de reconocimiento emocional o categorización biométrica:** informar a las personas afectadas.
4. **Excepciones:** arte, sátira, ficción declarada; law enforcement autorizado.

**Multas** hasta **15 M EUR o 3% del turnover global** por infracción.

Anti-patrones (dark) que Art. 50 combate específicamente:

- **Label minúsculo en gris claro** al pie.
- **Dismissible-and-forget** ("Ok, entendido" cierra y ya no aparece).
- **Jargon técnico** que el usuario medio no entiende ("powered by GPT-4").
- **Escondido en Terms of Service.**

Best practice: label prominente, en lenguaje claro, en el momento de la interacción. Ejemplo compliant:

```tsx
<div role="status" aria-live="polite" className="rounded bg-blue-50 border border-blue-200 p-3 mb-4">
  <strong>Estás hablando con una IA.</strong>{' '}
  Las respuestas se generan automáticamente y pueden contener errores.
  <a href="/how-ai-works" className="underline ml-2">Cómo funciona</a>
</div>
```

C2PA (**Coalition for Content Provenance and Authenticity**) es el standard técnico para watermarking de contenido sintético. OpenAI (DALL-E), Google (SynthID) y Meta (2024) lo implementan.

### 4.3 Feedback loops legítimos

Rate típico de thumbs feedback: **5–10%**. No es baja calidad; es baseline: la mayoría silenciosa no vota. Complementa con feedback implícito: regeneraciones, edits, copies, dwell time, follow-up questions.

Pipeline:

1. **Explicit**: thumbs + selector "por qué" (unhelpful, incorrect, harmful, other).
2. **Implicit**: eventos de app.
3. **Storage** con redacción PII (ver [cap 19](./19-data-pipelines-pii-eu-ai-act.md)) y tags de permisos.
4. **Categorization** de fallos: factual, harmful, off-topic, format, hallucination.
5. **Analysis** de patrones.
6. **Action**: prompts patch, eval dataset (ver [cap 09](./09-evals-datasets-llm-judge.md)), candidatos a fine-tuning, RLHF.
7. **Legal**: consent explícito para uso en training. GDPR + EU AI Act obligan base legal y transparencia. Opt-in para users EU es lo defendible.

Anti-patrón: recolectar feedback y **no cerrar el loop**. Cuando los users ven que sus thumbs down no cambian nada, dejan de votar.

### 4.4 Citation-worthy content

Los LLMs priorizan sources con **alta señal**. Checklist:

- **Original data**: benchmarks, encuestas, case studies, código en repos.
- **Expert quotes** con nombre y credencial.
- **Números concretos** con fuente.
- **Fechas visibles** (published, updated).
- **Ángulo único**: no rehash de contenido común.
- **Depth**: long-form > listicles.
- **Especificidad**: nombres, fechas, casos, ejemplos.
- **Balance**: reconocer trade-offs, no clickbait.
- **Estructura**: headers, tablas, listas.

Google llama a esto **E-E-A-T** (*Experience, Expertise, Authoritativeness, Trust*), y los principios se transfieren a GEO. Anti-patterns: contenido "slop" generado por IA sin edición, granjas de contenido, thin content, over-promotional, affiliate spam.

### 4.5 Presencia en fuentes de training

Los training corpora relevantes: **Common Crawl**, **Wikipedia**, **Reddit**, **StackOverflow**, **GitHub**, **arXiv**, licensed news (Axel Springer, News Corp, AP, FT con OpenAI; Reddit con Google por 60 M USD/año). Estar presente **legítimamente** en estas fuentes amplifica citation.

**Legítimo:**
- Earned media que lleva a notabilidad en Wikipedia (WP:CORP requiere cobertura independiente).
- Ingeniería contribuyendo respuestas útiles en StackOverflow.
- OSS visible en GitHub.
- Thought leadership: blogs de expertos, HN, dev.to, charlas de conferencia.
- Deals de licensing a escala.

**Ilegítimo (y contraproducente):**
- Astroturfing en Reddit → bans de sub y detección creciente por IA.
- Pagar posts sin disclosure → viola FTC endorsement guidelines.
- Wikipedia editing sin declarar conflicto de interés (WP:PAID) → borrado + ban.
- Content farms → Google demote 2024+.

### 4.6 Hallucination hijacking y defensa de marca

Fenómeno: un competidor produce contenido comparativo ("*X vs Y*", reviews sesgadas) que los LLMs sintetizan cuando alguien pregunta por tu marca. Vectores: comparison pages, review sites, outdated info dominante, false attribution donde el modelo confunde productos.

**Defensa multi-nivel:**

1. **Own comparison content** actualizado y honesto ("LinguaDev Pro vs Duolingo: cuándo elegir cuál").
2. **Structured data claro** (schema.org `Product` con features, differentiators, `Review` cuando aplique).
3. **Brand presence** en trusted sources.
4. **Monitor** con queries periódicas a Perplexity/ChatGPT/Claude/Gemini sobre tu marca (manual o con tooling).
5. **Respond**: publicar counter-narrative correcto y difundirlo.
6. **Legal** solo cuando hay defamación clara y demostrable (no para comparativa honesta).

### 4.7 Tracking de referrals de IA

Métodos triangulados (ninguno solo es suficiente):

- **Referrer analytics**: GA4, PostHog, Vercel Analytics capturan `chatgpt.com`, `chat.openai.com`, `perplexity.ai`, `gemini.google.com`, `copilot.microsoft.com`. Adobe Analytics añadió categorización nativa de referrers IA en 2024.
- **Monitoring tools**: **Profound.ai**, **Otterly.ai**, **Athena**, **BrandRank.ai** (2024+) automatizan queries a los modelos y trackean citations y posiciones.
- **Server logs**: user-agent de crawlers.
- **Cloudflare AI Audit** (2024): dashboard con visibilidad de crawlers.
- **Social listening**: menciones tipo "ChatGPT me dijo que…".

Limitaciones honestas: sampling, no comprehensive, ningún vendor publica citation data, y el "zero-click" (usuario lee la respuesta y no clickea) es invisible en referrer analytics.

Ejemplo mínimo de custom event en PostHog para clasificar referrer:

```ts
// lib/track-ai-referrer.ts
import posthog from 'posthog-js';

const AI_REFERRERS: Record<string, string> = {
  'chatgpt.com': 'chatgpt',
  'chat.openai.com': 'chatgpt',
  'perplexity.ai': 'perplexity',
  'www.perplexity.ai': 'perplexity',
  'gemini.google.com': 'gemini',
  'copilot.microsoft.com': 'copilot',
  'claude.ai': 'claude',
};

export function trackAIReferrer() {
  const ref = document.referrer;
  if (!ref) return;
  try {
    const host = new URL(ref).host;
    const source = AI_REFERRERS[host];
    if (source) {
      posthog.capture('ai_referral', {
        source,
        referrer: ref,
        landing_path: window.location.pathname,
      });
    }
  } catch { /* referrer inválido */ }
}
```

---

## 5. Ejemplo práctico completo: auditar y optimizar LinguaDev Pro para GEO/AEO

Aplicamos los pasos al proyecto real. Sustituye `linguadev.app` por tu dominio.

### Paso 1: ver el sitio como GPTBot

**Por qué empezar aquí.** Si tu página no es visible para el crawler, ninguna optimización posterior (llms.txt, schema, contenido) sirve. Es el equivalente a asegurar que Googlebot puede leer tu sitio antes de invertir en SEO.

```bash
mkdir -p ~/geo-audit && cd ~/geo-audit

curl -sS -A "GPTBot/1.0 (+https://openai.com/gptbot)" \
     -o gptbot.html \
     https://linguadev.app

# Verificación intermedia:
wc -l gptbot.html                                  # típico: 300-800 líneas si SSR
grep -oE '<h[1-3][^>]*>[^<]*</h[1-3]>' gptbot.html | head -20
grep -c "linguadev" gptbot.html                    # debe ser > 0
```

**Manejo de errores comunes:**
- `curl: (52) Empty reply from server`: tu CDN bloquea GPTBot. Revisa Cloudflare / WAF.
- HTML de 50 líneas con `<div id="root"></div>`: SPA sin SSR. Bloqueante.
- Redirect a login/paywall: revisa que la página pública sea accesible sin cookie.

Si `gptbot.html` es una página semi-vacía con `<div id="root"></div>` y sin contenido dentro, tu app se renderiza solo en cliente y estás invisible para training crawlers. Fix: migrar a SSR/SSG.

### Paso 2: verificar renderizado sin JS

```bash
# Compara "View Source" (HTML crudo) vs "Rendered" (post-JS)
curl -sS https://linguadev.app | grep -c "FSRS"   # HTML crudo
# 0 → problema: el contenido "FSRS" solo aparece tras hidratar
```

En Chrome DevTools: `Ctrl+Shift+P` → "Disable JavaScript" → recarga la página. Lo que veas es aproximadamente lo que ve `GPTBot`.

### Paso 3: crear `llms.txt`

**Por qué llms.txt aunque no sea standard oficial.** Coste marginal (5 minutos), riesgo bajo (no rompe SEO), upside plausible (algunos vendors ya lo consumen; adopción crece cada trimestre). Es la típica "apuesta asimétrica".

```bash
cat > public/llms.txt <<'MD'
# LinguaDev Pro

> PWA + backend serverless para pasar de A2 a B2/C1 en inglés con IA.
> Active recall, FSRS-6 y feedback estructurado con LLMs.

## Documentación clave

- [Empezar](https://linguadev.app/docs/getting-started.md): setup en 5 minutos.
- [Arquitectura](https://linguadev.app/docs/architecture.md): monorepo pnpm, AWS serverless, IndexedDB offline.
- [Motor FSRS](https://linguadev.app/docs/fsrs.md): implementación del algoritmo de repetición.
- [Módulo AI-Programming](https://linguadev.app/docs/ai-programming/README.md): 20 capítulos sobre construir productos LLM.

## Referencia técnica

- [API pública](https://linguadev.app/docs/api.md)
- [Modelos de datos](https://linguadev.app/docs/data-model.md)

## Optional

- [Roadmap 2026](https://linguadev.app/roadmap.md)
- [Changelog](https://linguadev.app/changelog.md)
MD
```

Sirve como `/llms.txt` en la raíz. Verifica: `curl -I https://linguadev.app/llms.txt` debe devolver 200 y `Content-Type: text/markdown` o `text/plain`.

**Verificación intermedia**: `curl -s https://linguadev.app/llms.txt | head -1` debe devolver `# LinguaDev Pro`. Si devuelve HTML (Next.js sirvió el 404), tu setup está sirviendo desde `pages/` en vez de `public/`.

### Paso 4: añadir schema.org FAQPage

**Por qué FAQPage especialmente.** Los LLMs son muy buenos citando Q&A: el formato es directo, sin parseo ambiguo. FAQPage schema le dice al crawler "aquí hay bloques Q→A machine-readable". Los rankings de citations de Perplexity 2025-2026 muestran overrepresentación de páginas con FAQPage.

Sobre una página existente `/docs/getting-started`:

```html
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <title>Empezar con LinguaDev Pro — guía en 5 minutos</title>
  <meta name="description" content="Setup local de LinguaDev Pro: pnpm, AWS SAM, primer ejercicio.">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
      {
        "@type": "Question",
        "name": "¿Qué necesito para empezar con LinguaDev Pro?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Node 20+, pnpm 9+, cuenta AWS con credenciales SAM configuradas y AWS CLI v2. En Windows funciona nativo o en WSL2."
        }
      },
      {
        "@type": "Question",
        "name": "¿Cuánto tarda el setup local?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "5-10 minutos si ya tienes Node y pnpm. El primer despliegue de la Lambda tarda unos 3 minutos adicionales."
        }
      },
      {
        "@type": "Question",
        "name": "¿Funciona sin conexión?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Sí para reviews básicas: el PWA cachea con Service Worker e IndexedDB. Las evaluaciones que llaman al LLM requieren red."
        }
      }
    ]
  }
  </script>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": "Empezar con LinguaDev Pro — guía en 5 minutos",
    "datePublished": "2026-08-13",
    "dateModified": "2026-08-13",
    "author": { "@type": "Person", "name": "Ale Miranda" },
    "publisher": {
      "@type": "Organization",
      "name": "LinguaDev Pro",
      "url": "https://linguadev.app"
    }
  }
  </script>
</head>
<body>
  <article>
    <h1>Empezar con LinguaDev Pro</h1>
    <p>Publicado: <time datetime="2026-08-13">13 de agosto de 2026</time></p>

    <section>
      <h2>¿Qué necesito para empezar con LinguaDev Pro?</h2>
      <p>Node 20+, pnpm 9+, cuenta AWS con credenciales SAM configuradas y AWS CLI v2. En Windows funciona nativo o en WSL2.</p>
    </section>
    <!-- resto paralelo al JSON-LD -->
  </article>
</body>
</html>
```

Validar con **Rich Results Test** (Google) y con `npx schema-dts-gen`.

### Paso 5: instrumentar tracking

`app/layout.tsx` (Next.js):

```tsx
'use client';
import { useEffect } from 'react';
import posthog from 'posthog-js';
import { trackAIReferrer } from '@/lib/track-ai-referrer';

export function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY!, {
      api_host: 'https://eu.posthog.com',
      capture_pageview: true,
    });
    trackAIReferrer();
  }, []);
  return <>{children}</>;
}
```

Server-side, en la Lambda que sirve páginas, loguea crawlers a CloudWatch:

```ts
// packages/api/src/middleware/ai-crawler-log.ts
const AI_UA_REGEX = /(GPTBot|ClaudeBot|PerplexityBot|OAI-SearchBot|ChatGPT-User|Google-Extended|CCBot|Bytespider|Applebot-Extended|Meta-ExternalAgent)/i;

export function logAiCrawler(event: { headers: Record<string, string>; rawPath: string }) {
  const ua = event.headers['user-agent'] ?? event.headers['User-Agent'] ?? '';
  const match = ua.match(AI_UA_REGEX);
  if (match) {
    console.log(JSON.stringify({
      metric: 'ai_crawler_hit',
      bot: match[1],
      path: event.rawPath,
      ua,
      ts: Date.now(),
    }));
  }
}
```

En CloudWatch Logs Insights:

```
fields @timestamp, bot, path
| filter metric = "ai_crawler_hit"
| stats count(*) by bot
| sort count desc
```

### Paso 6: componente Chat compliant Art. 50 con confidence + HITL + stop + citations

Aplicando todos los patrones a la vez en el flow de tutoría IA de LinguaDev Pro:

```tsx
// components/TutorChat.tsx — HITL edit-then-submit + Art. 50 disclosure
'use client';
import { useRef, useState } from 'react';
import { streamChat } from '@/lib/streaming';

type Confidence = 'high' | 'medium' | 'low';
interface Draft { text: string; confidence: Confidence; sources: { url: string; title: string }[] }

export function TutorChat() {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState<string[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  async function generate(prompt: string) {
    setBusy(true); setDraft(null);
    abortRef.current = new AbortController();
    let acc = '';
    try {
      await streamChat(prompt, t => { acc += t; setDraft({ text: acc, confidence: 'medium', sources: [] }); }, abortRef.current.signal);
      // En prod: parsear confidence + sources del final del stream
    } catch (e) {
      if ((e as Error).name !== 'AbortError') console.error(e);
    } finally { setBusy(false); abortRef.current = null; }
    setEditing(acc);
  }

  return (
    <div>
      {/* Art. 50 disclosure obligatorio, prominente */}
      <div role="status" aria-live="polite" className="mb-4 rounded bg-blue-50 border border-blue-200 p-3">
        <strong>Estás hablando con una IA.</strong>{' '}
        Las respuestas se generan automáticamente y pueden contener errores.{' '}
        <a href="/how-ai-works" className="underline">Cómo funciona</a>
      </div>

      <button onClick={() => generate('Explica el pretérito perfecto')} disabled={busy}>
        Generar explicación
      </button>

      {busy && (
        <button onClick={() => abortRef.current?.abort()} className="ml-2 bg-red-600 text-white px-3 py-1 rounded">
          Stop
        </button>
      )}

      {draft && !busy && (
        <div className="mt-4">
          <span className={`badge ${draft.confidence === 'low' ? 'bg-red-100' : 'bg-green-100'}`}>
            Confianza: {draft.confidence}
          </span>

          {/* Patrón edit-then-submit: usuario edita antes de guardar */}
          <textarea value={editing} onChange={e => setEditing(e.target.value)} rows={8} className="w-full mt-2" />

          {draft.sources.length > 0 && (
            <ol className="text-sm mt-2">
              {draft.sources.map((s, i) => (
                <li key={s.url}>[{i + 1}] <a href={s.url} target="_blank" rel="noreferrer">{s.title}</a></li>
              ))}
            </ol>
          )}

          <button
            onClick={() => { setSubmitted([...submitted, editing]); setDraft(null); }}
            className="mt-2 bg-blue-600 text-white px-3 py-1 rounded"
          >
            Guardar mi versión
          </button>

          {draft.confidence === 'low' && (
            <button onClick={() => alert('Escalando a tutor humano...')} className="ml-2 underline">
              Prefiero un tutor humano
            </button>
          )}
        </div>
      )}
    </div>
  );
}
```

**Qué demuestra el componente:**

- **Art. 50 disclosure** al inicio, prominente, en lenguaje claro (no jargon).
- **Stop button** activo durante streaming (Nielsen heurística #3).
- **Confidence badge** visible para calibrar confianza.
- **Edit-then-submit**: la respuesta IA es *borrador*, no decisión.
- **Citations verificables** con `target="_blank" rel="noreferrer"`.
- **Handoff a humano** cuando confidence es baja.

Todo en ~70 líneas y sin ninguna dependencia exótica.

### Extendiendo el ejemplo

Tres mejoras que llevan de demo a producto compliant:

**Mejora 1 — Confidence real del backend.** Ahora mismo `confidence` es fixed a `'medium'`. En prod, el backend calcula confidence como función de: (1) `logprob` mediano del token, (2) número de chunks retrievados y su similarity score, (3) presencia de hedging phrases ("creo que", "probablemente"). Emítelo al final del stream como `data: {"__meta": {"confidence": "high"}}\n\n`.

**Mejora 2 — C2PA watermarking para contenido sintético.** Si tu producto genera imágenes o audio (por ejemplo, pronunciación IA-generada), añade metadatos C2PA antes de servir. Bibliotecas: `c2patool` (CLI de Adobe, open-source) o `@contentauth/c2pa-node`. Sin esto, incumples Art. 50(2) desde 2 dic 2026.

**Mejora 3 — Referral tracker + dashboard.** Combina `trackAIReferrer()` de §4.7 con dashboard en PostHog:

```ts
// Insight en PostHog UI:
// SELECT source, count() as visits, count(DISTINCT distinct_id) as unique_users
// FROM events
// WHERE event = 'ai_referral' AND timestamp > now() - INTERVAL 30 DAY
// GROUP BY source ORDER BY visits DESC
```

En 30 días verás el mix: ChatGPT/Perplexity/Gemini/Copilot/Claude. Klarna documentó en 2025 que su tráfico de Perplexity valía 2× más por visita que Google (usuarios más específicos, buscando decisión).

---

## 6. Cheatsheet + reglas mentales + anti-patrones

### Reglas de oro

- ✅ Muestra **confidence** cuando el modelo puede fallar.
- ✅ **Stop button** en toda generación >1 s.
- ✅ **Stream** siempre que puedas.
- ✅ **Cita fuentes** verificables en respuestas RAG.
- ✅ **Handoff a humano** cuando el modelo no sabe.
- ✅ HITL por **reversibilidad + blast radius**, no por dogma.
- ✅ Errores **friendly + accionables**, no HTTP codes al usuario.
- ✅ **SSR/SSG** obligatorio si te importa GEO.
- ✅ **schema.org** + JSON-LD en cada página relevante.
- ✅ **llms.txt** en la raíz.
- ✅ **Decide por crawler** en `robots.txt`, no blanket allow/deny.
- ✅ **Fechas visibles** (published, updated).
- ✅ **Disclosure de IA** claro y prominente (Art. 50).
- ✅ **Cierra el loop de feedback** o los users dejan de dar feedback.
- ✅ **Multi-provider strategy** (aprendizaje del downtime de OpenAI 2023).

### Anti-patrones

- ❌ Sonar autoritativo siempre (overconfidence).
- ❌ Approval theater (humano hace clic sin leer).
- ❌ Synthetic "um, let me think…" (dark pattern anthropomorphism).
- ❌ Loading spinner sin status en operaciones >2 s.
- ❌ Exponer `429 rate limit exceeded` al end-user.
- ❌ SPA sin SSR intentando ranquear en Perplexity.
- ❌ Contenido JS-only sin `<noscript>` fallback.
- ❌ Keyword stuffing (SEO de 2005).
- ❌ Astroturfing en Reddit / Wikipedia.
- ❌ Disclosure "AI-generated" minúsculo en el pie.
- ❌ Bloquear TODOS los crawlers de IA sin distinguir search vs training.
- ❌ Alucinar URLs en citations sin validar.

### Tabla de decisión HITL

| Acción | Reversible | Blast radius | Patrón sugerido |
|---|---|---|---|
| Clasificar mail como spam | Sí (undo) | 1 usuario | Fully autonomous |
| Enviar mail de marketing a 10k | No | 10k | Approve-then-act + preview |
| Generar draft de post | Sí | 0 (borrador) | Edit-then-submit |
| Sugerir candidato a contratar | Sí | 1 vida | Suggest-only |
| Mensaje a un cliente | Parcial (30 s) | 1 cliente | Undo window |
| Deploy a producción | Con rollback | Todos | Approve + confirm |

---

## 7. Casos reales industria 2023-2026

**Perplexity vs NYT / Wired / Forbes (2024):**

- **Qué pasó**: Wired publicó en junio 2024 una investigación mostrando que PerplexityBot accedía a URLs bloqueadas en `robots.txt`, y que las respuestas de Perplexity reproducían párrafos casi textuales de contenido paywalled. NYT, Forbes y otros enviaron cartas de cease-and-desist.
- **Cómo se detectó**: Wired configuró honeypot URLs bloqueadas en robots.txt y observó hits del bot; correlacionó con outputs de Perplexity que citaban esos contenidos.
- **Cómo se arregló (parcialmente)**: Perplexity lanzó "Publishers Program" (julio 2024) con revenue sharing para publishers grandes. Añadió respeto explícito a robots.txt en su bot documentation.
- **Qué aprendió la industria**: el copyright IA está judicialmente en flujo; respeta robots.txt explícitamente y negocia deals si operas escala. Publishers ahora bloquean primero y negocian después.

**Klarna AI chatbot (feb 2024) + rollback parcial (2025):**

- **Qué pasó**: Klarna anunció en feb 2024 que su chatbot IA (built with OpenAI) "hacía el trabajo de 700 agentes humanos" y redujo staff de customer support en ~30%. Métricas iniciales spectaculares: -82% resolution time, +25% CSAT.
- **Cómo se detectó el problema (2024-2025)**: quejas en Reddit y Trustpilot subieron gradualmente; NPS interno cayó 15 puntos en 6 meses. Casos "el bot no entendió mi situación específica" acumulados.
- **Cómo se arregló**: CEO Sebastian Siemiatkowski admitió públicamente en mayo 2025 pérdidas de calidad. Anunciaron recontratación de humanos para casos complejos, manteniendo el bot para tier 1. El staff cut se revirtió parcialmente (~40% del cut original).
- **Qué aprendió la industria**: hype outpaces reality; HITL sigue siendo crítico incluso con LLMs frontier. La gráfica cost/CSAT tiene un punto de inflexión: más automatización más allá de X% degrada experiencia lo suficiente para perder revenue.

**Air Canada v Moffatt (feb 2024, BCCRT):**

- **Qué pasó**: el chatbot de Air Canada inventó una política de reembolso por duelo que no existía (dijo que el pasajero podía comprar tarifa completa y solicitar reembolso retroactivo dentro de 90 días). Jake Moffatt confió, compró el ticket, y Air Canada le negó el reembolso.
- **Cómo se detectó**: Moffatt demandó en BC Civil Resolution Tribunal (small claims). Air Canada argumentó que el chatbot era "un agente separado" responsable de sus propias declaraciones.
- **Cómo se arregló**: BCCRT falló en febrero 2024 a favor de Moffatt. La opinión del árbitro fue lapidaria: "Air Canada es responsable de toda la información en su website. No importa si viene de una página estática o un chatbot." Air Canada tuvo que pagar CAD 812 + costas.
- **Qué aprendió la industria**: precedente clave. Las empresas son legally accountable por sus AI outputs. En Q2-Q3 2024, docenas de empresas revisaron chatbots para: (1) añadir disclaimers explícitos, (2) restringir dominios de respuesta, (3) forzar handoff en preguntas de política crítica. El caso se cita como referencia obligatoria en cursos de AI legal risk 2025-2026.

**ChatGPT Search launch (oct 2024):** OpenAI lanzó búsqueda web integrada en ChatGPT con source cards obligatorias. Aceleró la adopción de GEO y llevó a Bing/Google a acelerar sus propias funciones. **Lección:** citations obligatorias son ahora tabla rasa.

**Cursor pricing changes (2024-2025):**

- **Qué pasó**: Cursor lanzó Pro tier $20/mes y "Ultra" $30/mes con "unlimited" fast requests en 2023. En 2024 crecimiento explotó (500k+ users). Power users con Claude Opus quemaban $500-1500/mes en tokens contra los $30 que pagaban.
- **Cómo se detectó**: análisis interno de unit economics mostró que 3% de users generaban 60% del coste. Sin ajuste, la runway se acortaba drásticamente.
- **Cómo se arregló**: Cursor eliminó "unlimited" a mediados de 2025, sustituyó por "500 fast requests + unlimited slow" con visualización clara de consumo. Comunidad tuvo backlash inicial en Reddit r/cursor (miles de comments negativos), pero se estabilizó en 2 meses. Muchos users aceptaron el nuevo pricing tras entender la matemática.
- **Qué aprendió la industria**: **la razón exacta fue que el modelo de negocio LLM-consumer con "unlimited" es matemáticamente inviable cuando el coste marginal por request es alto ($0.10-1.00) y la distribución de uso es bimodal**. Diseña con multi-provider strategy y evita vender unlimited si tu backend paga por uso. Instrumenta desde día 1 la distribución de consumo (no solo la media).

**Google AI Overviews — "glue on pizza" (may 2024):** Gemini en AI Overviews recomendó pegar queso a la pizza con pegamento (respuesta trazada a un joke en Reddit) y "comer al menos una piedra pequeña al día". Google pausó parcialmente. **Lección:** la calidad de sources y el hedging son críticos; sin filtros para content jokey, alucinas hechos absurdos.

**Samsung ChatGPT leak (abril 2023):** ingenieros de Samsung pegaron código propietario en ChatGPT y quedó expuesto. Samsung banó ChatGPT internamente. **Lección:** política de uso de LLMs con datos de empresa es obligatoria; usa versiones enterprise con data retention off.

**NYT v OpenAI (dic 2023, en curso 2024-2026):**

- **Qué pasó**: NYT demandó a OpenAI y Microsoft en diciembre 2023 alegando infracción de copyright a escala masiva. La demanda cita miles de ejemplos donde GPT-4 reproduce texto NYT casi verbatim. Reclama daños "en billones de dólares".
- **Cómo se detectó**: NYT ejecutó miles de prompts diseñados para triggerar reproducción y documentó reproducciones sustanciales de artículos paywalled.
- **Estado 2026**: en discovery. OpenAI argumenta fair use + transformación; NYT argumenta copyright directo. Sin fecha de juicio confirmada. Settlements en paralelo con Axel Springer, News Corp, AP, FT.
- **Qué aprendió la industria**: riesgo legal real. Si operas modelo, ten trazabilidad de training data (Art. 12 EU AI Act también lo pide). Si eres publisher, evalúa: (a) bloquear + demandar (NYT), (b) negociar deal (AP), (c) ambos secuencialmente.

**Perplexity Publishers Program (jul 2024):**

- **Qué pasó**: tras la controversia con Wired/Forbes, Perplexity lanzó programa de revenue sharing. Publishers reciben % del revenue de ads en las respuestas cuando su contenido es citado. Time, Fortune, Der Spiegel, Le Monde firmaron.
- **Cómo se detectó la necesidad**: presión legal + PR negativa. Sin programa, más publishers habrían seguido a NYT.
- **Cómo se arregló**: contract templates públicos, dashboard de citations por publisher, pagos trimestrales. Publishers pequeños siguen sin acceso (solo enterprise deals).
- **Qué aprendió la industria**: modelo mixto (deal para top publishers + bloquear resto) es la ruta viable en 2026. Los publishers pequeños quedan con opción binaria: bloquear GPTBot/PerplexityBot o aceptar scraping.

**Devin (Cognition, marzo 2024):** demos impresionantes; Answer.ai publicó una crítica ("The truth about Devin") mostrando <20% success rate en tareas reales vs 13.86% del benchmark SWE-bench Verified. **Lección:** benchmarks ≠ trabajo real; pilotea en tu codebase antes de comprar.

**EU AI Act enforcement (agosto 2026):** Art. 5 (prohibiciones) aplicable feb 2025; Art. 50 (transparencia) aplicable **2 agosto 2026**. Multas 15 M EUR / 3% turnover. **Lección:** compliance no es opcional; empieza el work ahora.

---

## 8. Ejercicios prácticos

### Ejercicio 1: Crear `llms.txt` para tu proyecto

**Objetivo:** publicar un `llms.txt` válido y verificable en la raíz de tu sitio.

**Setup:**
- Un sitio publicado (LinguaDev Pro u otro).
- Acceso al directorio `public/` (Next.js/Astro) o equivalente.

**Pasos:**
1. Redacta un `llms.txt` con el formato canónico: `# Título`, blockquote de summary, secciones con enlaces Markdown.
2. Guarda como `public/llms.txt`.
3. Despliega.
4. Verifica con `curl -I https://tu-dominio/llms.txt` que responde 200.
5. Añade a `sitemap.xml` opcionalmente.

**Criterios de éxito:**
- [ ] Archivo accesible en `/llms.txt` con status 200.
- [ ] `Content-Type` text/plain o text/markdown.
- [ ] Formato: H1, blockquote, al menos 3 secciones con enlaces.
- [ ] Todos los enlaces resuelven (no 404).
- [ ] Registrado en `llmstxt.org` directory (opcional).

**Bonus:** genera automáticamente el `llms.txt` a partir de tu sitemap con un script Node.

**Hints:**
- Next.js: coloca en `public/llms.txt` para que se sirva directo sin routing.
- Astro: colócalo en `public/` también; funciona igual.
- Enlaces absolutos siempre (`https://tu-dominio/...`), no relativos.

**Solución de referencia (Node script auto-gen desde sitemap):**
```js
// scripts/gen-llms-txt.js
import { readFileSync, writeFileSync } from 'fs';
import { parseString } from 'xml2js';
const sitemap = readFileSync('public/sitemap.xml', 'utf8');
parseString(sitemap, (_, r) => {
  const urls = r.urlset.url.map(u => `- [${u.loc[0]}](${u.loc[0]})`);
  writeFileSync('public/llms.txt', `# Mi Sitio\n\n> Descripción breve.\n\n## Páginas\n\n${urls.join('\n')}`);
});
```

---

### Ejercicio 2: Añadir `schema.org FAQPage` a una página existente

**Objetivo:** que Google Rich Results Test valide un FAQPage en una de tus páginas.

**Setup:**
- Página con contenido tipo Q&A (o adapta una existente).
- Acceso al HTML/template.

**Pasos:**
1. Identifica 3-5 preguntas frecuentes que ya tengas.
2. Añade `<script type="application/ld+json">` con el schema `FAQPage`.
3. Asegura que el HTML visible **coincide exactamente** con el JSON-LD (no cloaking).
4. Despliega.
5. Testea en `https://search.google.com/test/rich-results` con tu URL.
6. Verifica que devuelve "FAQ enabled" o "Válido".

**Criterios de éxito:**
- [ ] JSON-LD sintácticamente válido (parsea sin errores).
- [ ] `@type: FAQPage` con `mainEntity` array de `Question`.
- [ ] Rich Results Test devuelve "válido".
- [ ] Texto del JSON-LD == texto visible en HTML (paridad).
- [ ] Sin duplicados (mismo Q dos veces).

**Bonus:** añade también `Article` con `datePublished` y `dateModified`.

**Hints:**
- Errores JSON-LD comunes: comillas curly instead de rectas, `@type` sin `@` (mata todo).
- Cloaking penalty: si el texto del JSON-LD dice "5 minutos" pero el HTML muestra "30 minutos", Google penaliza.
- Rich Results Test: `https://search.google.com/test/rich-results?url=...`.

**Solución de referencia:** ver §3.4 del capítulo (FAQPage completo).

---

### Ejercicio 3: Auditar renderizado sin JS

**Objetivo:** confirmar que el contenido crítico de tu sitio es visible para crawlers que no ejecutan JS.

**Setup:**
- Chrome/Firefox DevTools.
- `curl` en terminal.

**Pasos:**
1. Elige 3 páginas importantes (landing, docs, un post).
2. Ejecuta `curl -sS https://tu-dominio/ruta | grep -E "<h1|<article|<main"` y confirma que hay contenido.
3. En Chrome: DevTools → `Ctrl+Shift+P` → "Disable JavaScript" → recarga.
4. Verifica visualmente que las 3 páginas siguen mostrando su contenido principal.
5. Repite con `curl -A "GPTBot/1.0"` y compara.
6. Documenta qué falta cuando JS está off.

**Criterios de éxito:**
- [ ] Las 3 páginas muestran H1, párrafos principales y navegación sin JS.
- [ ] `curl` devuelve HTML con contenido (no `<div id="root"></div>` vacío).
- [ ] Diff entre GPTBot y browser normal no oculta contenido crítico.
- [ ] Si algo falta, plan documentado para migrar a SSR/SSG.

**Bonus:** configura un test de CI (Playwright con JS disabled) que falle si el H1 no aparece.

**Hints:**
- Chrome DevTools: `Cmd/Ctrl+Shift+P` → "Disable JavaScript".
- `curl -sS ... | grep "id=\"root\""` — si aparece pero el H1 no, tienes SPA sin SSR.
- Playwright CI: `test.use({ javaScriptEnabled: false })`.

**Solución de referencia (Playwright test):**
```ts
test('h1 visible sin JS', async ({ browser }) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false });
  const page = await ctx.newPage();
  await page.goto('https://tu-dominio.com/');
  await expect(page.locator('h1')).toBeVisible();
});
```

---

### Ejercicio 4: Confidence indicator en un componente React

**Objetivo:** implementar un componente `<Answer>` con badge de confianza y handoff, y probarlo con datos mock.

**Setup:**
- Proyecto React/Next.js con TypeScript.
- Tailwind o CSS module.

**Pasos:**
1. Crea `components/AnswerWithConfidence.tsx` (usa el código de §2.1 como base).
2. Añade prop `confidence: 'high' | 'medium' | 'low'` con badge coloreado.
3. Añade citations numeradas clickables.
4. Añade botón "Hablar con humano" cuando `confidence === 'low'`.
5. Crea 3 stories (o casos en una página demo) con los 3 niveles.
6. Añade test unitario (Vitest/Jest) que verifique que el botón de handoff solo aparece con low confidence.

**Criterios de éxito:**
- [ ] Componente renderiza los 3 niveles con visual distinto.
- [ ] Citations son `<a target="_blank" rel="noreferrer">`.
- [ ] Botón handoff solo con `confidence === 'low'`.
- [ ] Test unitario pasa.
- [ ] Accesibilidad: `aria-label` en botones, contraste ≥ 4.5:1.

**Bonus:** integra con una API real que retorne confidence basado en `logprob` del token o en score de retriever.

**Hints:**
- Contrast ratio 4.5:1 mínimo: usa `contrast-ratio.com` para verificar.
- Vitest testing: `render(<Component confidence="low" />)` + `expect(screen.queryByRole('button', { name: /humano/i })).toBeInTheDocument()`.
- Para logprob real: OpenAI y Anthropic SDKs exponen `top_logprobs` en response.

**Solución de referencia (test):**
```ts
import { render, screen } from '@testing-library/react';
import { AnswerWithConfidence } from './AnswerWithConfidence';

test('handoff button only appears with low confidence', () => {
  render(<AnswerWithConfidence text="..." confidence="high" sources={[]} onEscalate={() => {}} />);
  expect(screen.queryByRole('button', { name: /humano/i })).toBeNull();

  render(<AnswerWithConfidence text="..." confidence="low" sources={[]} onEscalate={() => {}} />);
  expect(screen.getByRole('button', { name: /humano/i })).toBeInTheDocument();
});
```

---

### Ejercicio 5 (bonus): Tracker de referrals de IA

**Objetivo:** loguear en tu analytics cuántos visitantes vienen de ChatGPT/Perplexity/etc y con qué queries llegan.

**Setup:**
- PostHog, Vercel Analytics o GA4.
- Acceso al layout raíz del cliente.

**Pasos:**
1. Implementa `trackAIReferrer()` (usa el código de §4.7).
2. Llámalo en el mount del layout raíz.
3. Despliega.
4. Testea abriendo tu sitio desde una respuesta de Perplexity/ChatGPT que te cite.
5. Verifica en PostHog dashboard que aparecen eventos `ai_referral` con `source` clasificado.
6. Crea un dashboard con contador por source y landing page top.

**Criterios de éxito:**
- [ ] Eventos `ai_referral` aparecen en analytics.
- [ ] Campo `source` clasificado (chatgpt, perplexity, gemini, copilot, claude).
- [ ] Dashboard visible con al menos: count por source, top landing pages.
- [ ] Fallback silencioso si `document.referrer` es vacío o inválido.

**Bonus:** cross-reference con server logs de user-agents de crawlers para estimar el "zero-click" gap (crawlers indexan pero users no clickean).

---

## 9. Recursos + siguientes pasos

**Estándares y propuestas:**
- [llmstxt.org](https://llmstxt.org) — propuesta llms.txt oficial de Jeremy Howard.
- [schema.org](https://schema.org) — vocabulario completo.
- [C2PA](https://c2pa.org) — Content Authenticity Initiative para watermarking.
- [OpenAI GPTBot docs](https://platform.openai.com/docs/gptbot) — user-agent y política.

**UX de productos IA:**
- Google **PAIR People + AI Guidebook**.
- **Microsoft Human-AI Interaction Guidelines** (Amershi et al., CHI 2019, 18 rules).
- **Nielsen Norman Group** — AI chatbot UX patterns, response time limits.
- Anthropic UX guidelines (docs.anthropic.com).

**Regulación:**
- EU AI Act oficial — [artificialintelligenceact.eu](https://artificialintelligenceact.eu) — Art. 50 en particular.
- FTC AI Guidance — endorsement disclosures.

**GEO/AEO tools:**
- **Cloudflare AI Audit** — visibilidad de crawlers.
- **Profound.ai**, **Otterly.ai**, **Athena**, **BrandRank.ai** — monitoring de citations.
- Google Search Central — guidelines para AI Overviews.
- **Perplexity Publishers Program**.

**Referencias académicas:**
- Aggarwal et al. — *GEO: Generative Engine Optimization* (2023).
- Ouyang et al. — *Training language models to follow instructions with human feedback* (2022, InstructGPT / RLHF).

**Siguientes pasos:**
- Implementa los 5 ejercicios sobre LinguaDev Pro.
- Audita mensualmente `robots.txt`, `llms.txt` y schema.org.
- Suscribe alertas de novedades EU AI Act (aplicabilidad progresiva 2026-2027).
- Revisa el módulo de [data pipelines + PII](./19-data-pipelines-pii-eu-ai-act.md) para complementar el contexto regulatorio.
- Considera el [Vercel AI SDK](https://sdk.vercel.ai) para streaming y AbortController listos.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales, distribuidas entre `ai-ux-geo` y `ai-dev-practices`, dificultades junior → staff. Cubren: incertidumbre y confidence, HITL patterns, progressive disclosure, error handling, latency masking, stop button, cost transparency, citations, feedback loops, dark patterns con Art. 50, definición de GEO, crawlers y `robots.txt`, `llms.txt`, structured content, citation-worthiness, presencia en Wikipedia/Reddit/StackOverflow, hallucination hijacking, tracking de citations, prompt UX, y lecciones de casos famosos (Klarna, Air Canada, NYT, Devin, Cursor).

- **Fuente:** [`packages/content/src/tech/ai-programming/sim-20-ai-product-ux-geo-aeo.json`](../../packages/content/src/tech/ai-programming/sim-20-ai-product-ux-geo-aeo.json)
- **Ruta en app:** `/programming/ai-programming/sim/ai-programming-sim-20-ai-product-ux-geo-aeo`
- **Tiempo:** 25 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 19 — data pipelines + PII + EU AI Act](./19-data-pipelines-pii-eu-ai-act.md) · [Índice](./README.md)

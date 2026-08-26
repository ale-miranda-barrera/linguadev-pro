# Capítulo 07 — Networking, HTTP y TCP en profundidad

> **Focus:** Cómo viaja realmente un byte desde tu cliente al servidor: TCP handshake, TLS 1.3, HTTP/1.1 vs 2 vs 3 (QUIC), keep-alive, connection pooling, HOL blocking, cache-control, CORS, WebSockets vs SSE, CDN y MTU. Debug con `curl`, `dig`, `tcpdump`.
> **Áreas:** APIs · Transport · Protocol design · Networking sysadmin.
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 28 min · **Pass:** 75%.
> **Nivel:** Junior → Mid → Senior → Staff.

## 0. Antes de empezar

**Pre-requisitos:**
- Comprensión de procesos, sockets y modelo cliente/servidor.
- Uso básico de `curl` y `nc`.
- Idealmente haber leído [Cap 05 — I/O, syscalls y filesystems](./06-memoria-y-gc.md) y [Cap 06 — memoria y GC](./06-memoria-y-gc.md).
- Conocer nociones de latency percentiles (P50/P95/P99).

**Glosario mínimo:**
- **RTT** (Round-Trip Time): tiempo ida y vuelta entre dos hosts. Sobre WiFi cercano ~10-30 ms; móvil 40-100 ms; intercontinental 100-300 ms.
- **MSS** (Maximum Segment Size): payload máximo por segmento TCP. Típicamente MTU - 40 bytes (IP+TCP headers) = 1460 en Ethernet.
- **cwnd** (Congestion Window): cuántos bytes puede el sender tener en vuelo sin ACK.
- **BDP** (Bandwidth-Delay Product): capacidad de la tubería = bandwidth × RTT. Ejemplo: 100 Mbps × 200 ms = 2.5 MB.
- **HOL blocking** (Head-of-Line): cuando un elemento bloqueado detiene toda la cola detrás.
- **QUIC**: protocolo transport sobre UDP con streams independientes, TLS integrado y connection migration; base de HTTP/3.
- **AEAD**: cifrado autenticado con datos asociados (AES-GCM, ChaCha20-Poly1305). Único modo permitido en TLS 1.3.
- **PMTUD**: Path MTU Discovery, mecanismo para descubrir la MTU mínima del camino.
- **SNI** (Server Name Indication): extensión TLS que anuncia qué hostname quiere el cliente (para hosting virtual TLS).

**Setup mínimo:**

```bash
# Linux/macOS: herramientas base
sudo apt install curl dnsutils tcpdump iproute2 iputils-ping mtr-tiny netcat-openbsd
# o en macOS:
brew install curl bind wireshark mtr

# Verifica versiones (curl >= 8 soporta HTTP/3 via --http3)
curl --version
dig -v
sudo tcpdump --version

# Herramientas modernas
brew install httpie
cargo install oha
```

En Windows funciona con WSL2 o con `curl.exe` de Windows 11.

---

## 1. El gran cuadro

Toda petición HTTP que haces desde tu navegador o servicio atraviesa una pila que la mayoría de developers trata como magia negra hasta el primer incidente en producción. El stack tradicional es: **aplicación (HTTP) → seguridad (TLS) → transporte (TCP o QUIC/UDP) → red (IP) → enlace (Ethernet/WiFi)**. Cada capa aporta un header, latency y modos de fallo. Ignorar cómo interactúan es la razón por la que un servicio que rinde 500 req/s en localhost colapsa a 50 req/s en producción, o por qué un chat que funciona cae al 4G del metro pero no del WiFi de casa.

El segundo eje es el **cambio generacional 2015–2026**: pasamos de HTTP/1.1 con seis conexiones por dominio y TLS 1.2 con handshake de 2 RTT, a HTTP/2 con multiplexing pero atado a TCP, y ahora HTTP/3 sobre QUIC que resuelve la HOL blocking real. En 2026, HTTP/3 alcanzó **35% de adopción global** según Cloudflare y **>50% en el top-1000 de tráfico**; Chrome, Firefox, Safari y Edge lo soportan por default y Nginx lo tiene estable desde 1.25 (2023). TLS 1.3 es prácticamente universal en tráfico moderno, con 1-RTT como norma y 0-RTT en resumption.

El tercer factor es la **latency como recurso escaso**. Un usuario en Buenos Aires accediendo a un servidor en Frankfurt sufre ~230 ms de RTT. Una arquitectura ingenua que abre una nueva conexión HTTPS por request paga 3 RTT de setup (TCP + TLS 1.2) = 690 ms antes del primer byte. Con keep-alive, TLS 1.3, HTTP/2 y CDN de edge cercano, esos 690 ms se pueden bajar a 20-50 ms. La diferencia entre app rápida y app aceptable es literalmente saber HTTP.

Este capítulo cubre cómo funciona cada capa, dónde están los bugs típicos (TIME_WAIT, Nagle+delayed-ACK, PMTUD blackholes, DNS cache infinita, CORS preflight) y cómo debuggear con `curl`, `dig`, `tcpdump`, `mtr`. Termina con ejercicios prácticos aplicables a **LinguaDev Pro**, que sirve un PWA con backend serverless AWS: cada milisegundo importa para la UX de repetición espaciada.

---

## 2. TCP y TLS: el coste real del setup (nivel básico)

### 2.1 El handshake de tres vías

Antes de que una app pueda mandar un byte, TCP negocia una conexión con el **three-way handshake**:

1. Cliente envía `SYN` (seq=X).
2. Servidor responde `SYN-ACK` (seq=Y, ack=X+1).
3. Cliente responde `ACK` (ack=Y+1) y ya puede mandar datos.

Coste: **1 RTT** antes del primer byte de aplicación. En LAN (~0.1 ms) es invisible. Sobre 4G (~50 ms) o intercontinental (~200 ms), es dominante.

Extensión útil: **TCP Fast Open** (RFC 7413) permite datos en el `SYN` en conexiones repetidas usando una cookie. Adoptado por Linux, macOS y Chrome, pero muchos middleboxes lo dropean.

### 2.2 TLS 1.2 vs TLS 1.3

**TLS 1.2** requiere 2 RTT adicionales:
1. `ClientHello` → `ServerHello + Certificate + ServerKeyExchange + ServerHelloDone`.
2. `ClientKeyExchange + ChangeCipherSpec + Finished` → `ChangeCipherSpec + Finished`.

Total con TCP: **3 RTT** antes del primer byte HTTPS. Sobre WiFi (~30 ms) = 90 ms. Sobre satélite (~600 ms) = 1.8 s.

**TLS 1.3** (RFC 8446, agosto 2018) reduce a **1 RTT**: el `ClientHello` incluye ya key shares tentativos, el servidor responde con selección + certificate cifrado. En **resumption** (session tickets), 0 RTT es posible: la primera app-data va en el mismo primer paquete. Cuidado con 0-RTT: es replay-vulnerable, úsalo solo con requests idempotentes.

Otras mejoras clave de TLS 1.3:
- **Forward secrecy obligatoria**: sólo ECDHE/DHE (ephemeral). Un breach del private key no expone tráfico pasado.
- **AEAD-only**: AES-GCM, ChaCha20-Poly1305. Adiós CBC, RC4, MD5, SHA-1, static RSA.
- **Encrypted handshake**: certificate cifrado desde `ServerHello`.
- **ECH** (Encrypted Client Hello, borrador maduro en 2026): cifra también el SNI, dificulta censura por hostname.

Adopción 2026: >95% del tráfico HTTPS moderno. Legacy pre-2020 (IIS antiguo, algunos load balancers on-prem) sigue en 1.2.

### 2.3 Medir el handshake con curl

```bash
# Formato de tiempos por fase
curl -s -o /dev/null -w "\
dns:      %{time_namelookup}s\n\
connect:  %{time_connect}s\n\
tls:      %{time_appconnect}s\n\
ttfb:     %{time_starttransfer}s\n\
total:    %{time_total}s\n\
version:  %{http_version}\n\
" https://linguadev.app

# Forzar HTTP/3 vs HTTP/2 y comparar
curl --http3-only -o /dev/null -w "%{http_version} %{time_total}s\n" https://cloudflare.com
curl --http2      -o /dev/null -w "%{http_version} %{time_total}s\n" https://cloudflare.com

# Ver los certificados y ciphers negociados
curl -v --tls-max 1.3 https://linguadev.app 2>&1 | grep -E "TLSv|cipher"
```

Interpretación: `time_appconnect - time_connect` es el coste puro de TLS. Si es >100 ms sobre red decente, probablemente estás con TLS 1.2 y RTT medio-alto.

### 2.4 Sesiones y resumption

TLS 1.3 permite dos formas de resumir sesión evitando volver a negociar:

- **Session ticket**: el servidor envía un blob cifrado con la clave de sesión; el cliente lo guarda y lo presenta en la próxima conexión.
- **PSK (Pre-Shared Key)**: identidad + clave compartida acordada out-of-band.

Ambas habilitan 0-RTT. En una LB farm, los tickets deben cifrarse con clave compartida entre nodos, o el resumption fallará al reconectar a un nodo distinto (patrón sticky by node o shared ticket key).

---

## 3. HTTP: de 1.1 a HTTP/3 (nivel medio)

### 3.1 HTTP/1.1 y sus límites

HTTP/1.1 (RFC 2616, 1999; refinado en RFC 7230-7235, 2014) trajo keep-alive por default: la conexión TCP se reutiliza entre requests. Amortiza handshake y evita TIME_WAIT explosivo. Pero mantiene **HOL blocking a nivel HTTP**: request N+1 no puede empezar hasta que la respuesta N termine. El pipelining teórico nunca se implementó bien.

Workaround pre-HTTP/2: **6 conexiones paralelas por dominio** (regla no escrita de los browsers) + **domain sharding** (servir assets desde `img1.cdn.com`, `img2.cdn.com`, `img3.cdn.com` para tener 6×N conexiones). Hoy es anti-patrón: HTTP/2 lo hace innecesario y contraproducente.

```
HTTP/1.1 sobre 6 conexiones paralelas
=====================================
   Client                    Server
   ------                    ------
   [Conn 1] --GET /a-------->|
            <--200-----------|
            --GET /b-------->|     <- sequencial por conn (HOL block)
            <--200-----------|
   [Conn 2] --GET /c-------->|
            <--200-----------|
   ...
   [Conn 6] --GET /f-------->|

   Total = 6 handshakes TCP + 6 handshakes TLS + 6 x latency de servidor.
   Domain sharding aumenta a 6xN pero paga N veces el setup.
```

### 3.2 HTTP/2 (RFC 7540/9113, 2015-2022)

Cambios clave:
- **Binary framing**: reemplaza el text-based parsing de HTTP/1. Menos ambiguo, más rápido.
- **Multiplexing**: N streams sobre 1 conexión TCP. Elimina HOL blocking a nivel HTTP.
- **HPACK header compression** (RFC 7541): tabla dinámica + estáticas + Huffman. Reduce headers repetidos (cookies, User-Agent) en ~90%.
- **Server push**: servidor puede enviar recursos preventivamente. Prácticamente muerto en 2026 (Chrome lo desactivó en 2022 por bajo uso y complejidad).
- **Stream priority**: hints para ordenar respuestas.

```
HTTP/2: 1 conexion TCP + N streams multiplexados
================================================
   Client                              Server
   ------                              ------
   TCP connection (una sola, keep-alive)
     +-- stream 1: GET /a -->|
     +-- stream 3: GET /b -->|
     +-- stream 5: GET /c -->|
     +-- stream 7: GET /d -->|
                             |
     +-- stream 1 <-- DATA (frames intercalados)
     +-- stream 5 <-- DATA
     +-- stream 3 <-- DATA (fuera de orden vs pedido)
     +-- stream 7 <-- DATA
     +-- stream 5 <-- DATA end
     +-- stream 1 <-- DATA end

   HPACK dedup cookies/User-Agent -> headers 90% menos bytes.
   Un solo handshake TCP + TLS para todo.
```

**El límite que forzó HTTP/3**: HTTP/2 sigue sobre TCP. Si un paquete TCP se pierde, TODO el stream de bytes se detiene esperando retransmisión, aunque los otros streams multiplexados no lo necesiten. En redes lossy (WiFi malo, móvil, satélite), HTTP/2 puede rendir **peor** que HTTP/1.1 con 6 conexiones paralelas.

### 3.3 HTTP/3 y QUIC (RFC 9114, 2022)

QUIC (RFC 9000) es el nuevo transport, sobre UDP:
- **Streams independientes a nivel transport**: pérdida en stream 3 no afecta stream 7.
- **TLS 1.3 integrado**: combina handshake TCP+TLS en 1 RTT (0-RTT en resumption).
- **Connection migration**: identificación por `Connection ID` (no por 4-tupla). El móvil cambia de WiFi a 4G sin perder la conexión.
- **Ossification fix**: TCP era imposible de evolucionar (kernels lentos de actualizar, middleboxes que se rompen con cualquier extensión). Al ir sobre UDP con paquete cifrado end-to-end, los middleboxes no pueden inspeccionar/romper.

```
HTTP/3 sobre QUIC (UDP)
=======================
   Client                              Server
   ------                              ------
   UDP + QUIC (combina TCP + TLS + HTTP/2 features)
     +-- Initial (ClientHello + 0-RTT app data) ---->|
     |<-- Handshake (ServerHello + certs + finished) |
     |-- Handshake finished ------------------------->|
     |
     +-- stream 4: GET /a -->|
     +-- stream 8: GET /b -->|
     +-- stream 12: GET /c ->|
                             |
     +-- stream 4 <-- DATA (si stream 8 pierde paquete, stream 4 sigue!)
     +-- stream 12 <-- DATA
     +-- stream 8 <-- DATA con retransmision aislada
     +-- stream 4 <-- DATA end

   Connection ID persiste al cambiar de IP/puerto:
     WiFi 192.168.1.5 -> LTE 10.20.30.40 sin renegociar. La misma conn.
```

QPACK (RFC 9204) reemplaza HPACK para evitar re-introducir HOL blocking a nivel de compresión.

**Estado 2026** (verificado): HTTP/3 en ~35% global (Cloudflare), >50% en top-1000 sites. Chrome, Firefox, Safari, Edge lo tienen por default. Nginx 1.25+ (May 2023) trae soporte estable. CloudFront, Cloudflare, Fastly, Akamai lo ofrecen en edge. curl 8+ soporta `--http3`.

### 3.4 Ejemplo: cliente HTTP moderno con connection pool

Python con `httpx` (soporta HTTP/2, HTTP/3 experimental via aiohappyeyeballs y trio):

```python
# client_http2.py
import asyncio
import httpx

# Limits: pool sizing consciente. Ver Ley de Little en §5.1
LIMITS = httpx.Limits(
    max_connections=100,        # tope global de conexiones simultáneas
    max_keepalive_connections=20,  # cuántas quedan warm entre bursts
    keepalive_expiry=30.0,      # segundos antes de cerrar por idle
)

async def main() -> None:
    # http2=True negocia h2 via ALPN si el server lo soporta;
    # con timeout global de 10s cortamos hangs de servers zombie.
    async with httpx.AsyncClient(http2=True, limits=LIMITS, timeout=10.0) as client:
        urls = [f"https://linguadev.app/api/cards/{i}" for i in range(1, 51)]
        # Multiplexing HTTP/2: 50 requests concurrentes con pocas conexiones TCP.
        # Con h2 tipicamente 2-4 conexiones bastan para 50 streams.
        tasks = [client.get(u) for u in urls]
        responses = await asyncio.gather(*tasks, return_exceptions=True)
        for u, r in zip(urls, responses):
            if isinstance(r, Exception):
                print(f"FAIL {u}: {r!r}")
            else:
                # r.http_version reporta el protocolo real: HTTP/2, HTTP/1.1
                print(f"{r.status_code} {r.http_version} {u}")

asyncio.run(main())
```

Comentario clave: sin `Limits` explícitos, `httpx` usa defaults conservadores (100 max_connections). En producción a alto QPS, mide y ajusta con la Ley de Little del §5.1.

Java con `HttpClient` JDK 21+:

```java
// Http2Client.java
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CompletableFuture;

public final class Http2Client {

    // Un cliente reutilizable: internamente maneja pool de conexiones.
    // Crear uno por request es el bug mas comun en Java networking.
    private static final HttpClient CLIENT = HttpClient.newBuilder()
        .version(HttpClient.Version.HTTP_2)      // negocia h2 via ALPN, fallback a h1
        .connectTimeout(Duration.ofSeconds(3))   // rechazo rapido si server esta caido
        .build();

    public static void main(String[] args) {
        List<String> paths = List.of("/api/cards/1", "/api/cards/2", "/api/cards/3");

        // Stream funcional: construye N requests, dispara N sendAsync, junta con join.
        // Cada sendAsync devuelve CompletableFuture -> concurrencia real.
        List<CompletableFuture<HttpResponse<String>>> futures = paths.stream()
            .map(p -> HttpRequest.newBuilder(URI.create("https://linguadev.app" + p))
                .timeout(Duration.ofSeconds(5))
                .header("Accept", "application/json")
                .GET().build())
            .map(req -> CLIENT.sendAsync(req, HttpResponse.BodyHandlers.ofString()))
            .toList();

        futures.forEach(f -> {
            HttpResponse<String> r = f.join();
            // r.version() confirma HTTP_2 si el server acepto; HTTP_1_1 en fallback.
            System.out.printf("%d %s length=%d%n",
                r.statusCode(), r.version(), r.body().length());
        });
    }
}
```

En Java 21+, cada `sendAsync` se coordina con virtual threads si el ejecutor los usa (ver [Cap 09](./09-async-patterns-profundo.md)). Regla: **1 HttpClient global**, no `new` por request.

**Ejemplo comparativo Go con connection pool explícito:**

```go
// go_http_pool.go
package main

import (
    "context"
    "fmt"
    "io"
    "net"
    "net/http"
    "time"
)

// Transport reutilizable: define pool de conexiones + timeouts por fase.
// http.DefaultClient NO tiene timeouts -> anti-patron en produccion.
var transport = &http.Transport{
    // Pool tuning
    MaxIdleConns:        200,        // total de conexiones idle en cache
    MaxIdleConnsPerHost: 40,         // por host (dominio+puerto)
    MaxConnsPerHost:     100,        // hard cap por host
    IdleConnTimeout:     90 * time.Second,

    // Handshake timeouts individuales por fase
    TLSHandshakeTimeout:   3 * time.Second,
    ResponseHeaderTimeout: 5 * time.Second,
    ExpectContinueTimeout: 1 * time.Second,

    // ALPN negocia h2 si server lo ofrece; ForceAttemptHTTP2 lo prioriza.
    ForceAttemptHTTP2: true,

    // Dialer con TCP keep-alive activo (importante para NAT/LB)
    DialContext: (&net.Dialer{
        Timeout:   3 * time.Second,
        KeepAlive: 30 * time.Second,
    }).DialContext,
}

var client = &http.Client{
    Transport: transport,
    Timeout:   10 * time.Second, // safety net global
}

func main() {
    ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
    defer cancel()

    req, _ := http.NewRequestWithContext(ctx, "GET",
        "https://linguadev.app/api/cards/42", nil)

    resp, err := client.Do(req)
    if err != nil {
        fmt.Println("error:", err)
        return
    }
    defer resp.Body.Close()

    body, _ := io.ReadAll(resp.Body)
    fmt.Printf("status=%d proto=%s len=%d\n", resp.StatusCode, resp.Proto, len(body))
}
```

Comentario clave: en Go, olvidar `resp.Body.Close()` mata la reutilización del pool. Cada conexión no cerrada queda ocupada hasta que el garbage collector la libere (segundos después). El fix es SIEMPRE `defer resp.Body.Close()` inmediatamente tras chequear `err`.

---


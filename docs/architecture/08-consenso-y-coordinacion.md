# Capítulo 08 — Consenso y coordinación distribuida

> **Focus:** Cómo los sistemas distribuidos se ponen de acuerdo cuando la red miente, los relojes se desincronizan y los nodos se caen o pausan sin avisar.
> **Áreas:** resilience · scalability · db-choice
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 28 min · **Pass:** 75%
> **Nivel:** Medio → Avanzado (senior/staff)

## 0. Antes de empezar

**Pre-requisitos:**
- Haber leído [Cap 06 — CAP y consistencia](./06-cap-y-consistencia.md); aquí profundizamos en el lado **C** con protocolos concretos.
- Nociones de sistemas distribuidos: replicación, quorum, red asíncrona, particiones.
- Familiaridad con al menos uno de: etcd, Consul, ZooKeeper, Kafka.

**Glosario mínimo:**
- **Consenso:** N procesos deben acordar un valor (o secuencia) a pesar de fallos y mensajes retrasados.
- **Quorum:** número mínimo de nodos que deben acordar; para *crash fault tolerance* con `N` réplicas, `Q > N/2`.
- **Leader election:** elegir un nodo primario que serializa las escrituras; complementa consensus.
- **Raft:** protocolo de consenso (Ongaro-Ousterhout 2014) diseñado para *understandability*; base de etcd, Consul, TiKV, CockroachDB, Kafka KRaft.
- **Paxos:** protocolo canónico (Lamport 1998), muy potente pero notoriamente difícil de implementar; base de Google Chubby/Spanner.
- **Split-brain:** dos nodos creen simultáneamente ser líderes; corruption garantizada si no se previene.
- **Fencing token:** número monotónico devuelto al adquirir un lock, validado por el recurso destino para descartar operaciones stale.
- **Lease:** permiso con TTL; el titular pierde autoridad automáticamente al expirar si no renueva.
- **HLC (Hybrid Logical Clock):** combina tiempo físico (NTP) y lógico (Lamport) para timestamps que respetan causalidad y son cercanos a wall-clock. CockroachDB, YugabyteDB, MongoDB 4.2+.
- **Byzantine fault tolerance (BFT):** tolerar nodos maliciosos, no solo caídos; requiere `N ≥ 3F+1`.
- **STONITH:** *Shoot The Other Node In The Head*; fence físico (power off) para evitar split-brain en clusters HA (Pacemaker, DRBD).

**Setup mínimo:**

```bash
# etcd 3.6 (release estable de 2025, patches 3.6.x en 2026)
docker run -d --name etcd -p 2379:2379 -p 2380:2380 \
  --env ALLOW_NONE_AUTHENTICATION=yes \
  --env ETCD_ADVERTISE_CLIENT_URLS=http://localhost:2379 \
  bitnami/etcd:3.6.12

# Cluster etcd de 3 nodos con docker compose (ver §5)
# Consul dev mode
docker run -d --name consul -p 8500:8500 hashicorp/consul:1.20 agent -dev -client 0.0.0.0

# Herramientas
brew install etcd            # CLI etcdctl
brew install consul          # CLI consul

# Verificar
etcdctl endpoint health --endpoints=http://localhost:2379
consul members
```

---

## 1. El gran cuadro

En un sistema distribuido con más de un nodo, cualquier decisión que deba ser **consistente** requiere que varios nodos se pongan de acuerdo: quién es el líder, cuál es la última versión de una configuración, si una transacción se compromete o aborta, quién procesa cada shard. Esta necesidad se llama **consenso** y su tratamiento formal empezó en los años 80 con el teorema **FLP** (Fischer-Lynch-Paterson, 1985) que demostró que **en un modelo asíncrono puro, con al menos un fallo, no existe algoritmo determinista que garantice terminación**. Este resultado no es esotérico: es la razón por la que Raft, Paxos, Zab y cualquier consensus protocol práctico necesita **timeouts** (asumiendo partial synchrony) o **randomización** — jamás garantiza terminación en asincronía pura.

De ahí nacen los protocolos productivos. **Paxos** (Lamport 1998) es matemáticamente elegante pero notoriamente difícil de entender e implementar; incluso Google, que lo usa en Chubby y Spanner, publicó papers admitiendo la dificultad de hacerlo bien. **Raft** (Ongaro-Ousterhout 2014) fue diseñado **explícitamente** para *understandability* — el paper se llama literalmente *In Search of an Understandable Consensus Algorithm* — y esa decisión ingenieril tuvo consecuencias industriales: en la década siguiente Raft fue implementado correctamente decenas de veces (etcd, Consul, TiKV, CockroachDB, RethinkDB, ScyllaDB, Nomad, Redpanda) mientras Paxos production-correcto sigue siendo dominio de pocas empresas. Kafka, incluso, migró de ZooKeeper (Zab, primo de Raft) a **KRaft** desde 2.8 y en 2026 corre sin ZooKeeper como default.

El segundo bloque de este capítulo es el peligro de los **locks distribuidos**. Martin Kleppmann publicó en 2016 el análisis definitivo mostrando que Redlock (algoritmo Redis con cinco masters y majority quorum) **no es safe** bajo GC pauses, network delays o clock jumps. El problema es fundamental: cualquier lock con TTL sufre de *client pause* — el cliente puede creer aún tener el lock cuando el TTL expiró y otro lo adquirió. La única solución robusta son los **fencing tokens** (Chubby los llama sequencer numbers): un número monotónico devuelto al adquirir, validado por el recurso destino, que descarta cualquier operación con token stale. Pero eso exige la cooperación del recurso; muchos (S3 puro, APIs sin `If-Match`) no lo soportan nativamente. La conclusión de nivel staff: **preferir diseños que eviten necesitar locks distribuidos** (particionar por hash, idempotencia, leader election vía consensus).

El tercer bloque cubre coordination services concretos y el trade-off práctico. **ZooKeeper** (Java, Zab, ~2008) sigue siendo la base de Hadoop, HBase y muchos legacy. **etcd 3.6** (2025, patches 3.6.x y 3.7 beta en 2026, Go, Raft) es el store del control plane de Kubernetes y el estándar cloud-native. **Consul 1.20** (2026, Go, Raft) es HashiCorp con service discovery + health checks + KV + Consul Connect (service mesh). La elección se basa en ecosystem que ya usas, feature set y familiaridad operacional; los tres son CP en CAP (sacrifican availability por consistency bajo partition). El impacto acumulado: entender FLP, saber por qué Raft ganó, distinguir liveness de safety, conocer las trampas de los distributed locks y elegir el coordination service adecuado son competencias directamente evaluadas en entrevistas de nivel senior/staff y presentes en cualquier post-mortem de outage grave (GitHub 2018, Cloudflare 2020, la mayoría de incidentes de Kubernetes con etcd degradado).

---

## 2. Fundamentos de consenso (nivel medio)

### 2.1 FLP y por qué necesitamos timeouts

Fischer, Lynch y Paterson demostraron en 1985 que en un sistema asíncrono puro (sin bounds en delay de mensajes o procesamiento), con **al menos un fallo por crash**, **no existe algoritmo determinista que resuelva consenso garantizando terminación**. La intuición: no puedes distinguir "el nodo está muerto" de "el nodo está muy lento" sin timeout, y si asumes lo primero cuando era lo segundo, dos nodos pueden avanzar con estados incompatibles.

Consecuencias prácticas:
- **Todo protocolo real** (Paxos, Raft, Zab, PBFT) usa timeouts y asume *partial synchrony* (Dwork-Lynch-Stockmeyer 1988): mensajes eventualmente se entregan en un bound conocido.
- **Bajo network chaos**, consenso puede stall: elecciones repetidas, no progreso.
- La *eventual consistency* es en parte una respuesta pragmática a FLP: si consenso es tan caro, evita necesitarlo cuando puedas (Dynamo, Cassandra, Riak).

Bug clásico consecuencia de FLP: etcd antes de 2015 sufría *election storms* cuando la red flappeaba; el fix fue el **Pre-Vote optimization** de Raft (Ongaro thesis §9.6).

### 2.2 Raft en cinco minutos

Raft descompone consensus en tres subproblemas ortogonales:

1. **Leader election.** Cada nodo tiene un `term` (contador monotónico). Al arrancar es follower. Si no recibe heartbeat en `election_timeout` (randomizado 150-300 ms), incrementa term y se convierte en candidate, vota por sí mismo y pide votos. Si obtiene mayoría, se convierte en leader.
2. **Log replication.** Solo el leader acepta writes. Los apendea a su log, los replica a followers vía `AppendEntries`. Cuando la mayoría los ha persistido, el leader los declara **committed** y los aplica a su state machine.
3. **Safety.** Election restriction: un candidate solo puede ganar si su log es *at least as up-to-date* como el de la mayoría (compara último term, luego índice). Log matching: mismo `index+term` = mismo contenido en todos los logs. Leader completeness: el leader tiene todos los entries committed de terms anteriores.

Estas propiedades garantizan que jamás haya dos leaders con quorum simultáneamente, y que un entry committed nunca se pierda.

Ejemplo minimal de estructura de mensaje `AppendEntries` (extracto):

```go
// Fragmento del protocolo Raft (Go, estilo hashicorp/raft)
type AppendEntriesRequest struct {
    Term         uint64
    LeaderID     string
    PrevLogIndex uint64
    PrevLogTerm  uint64
    Entries      []LogEntry
    LeaderCommit uint64
}

type AppendEntriesResponse struct {
    Term    uint64
    Success bool
    ConflictIndex uint64 // para acelerar catch-up si el follower divergió
}

func (r *Raft) handleAppendEntries(req *AppendEntriesRequest) *AppendEntriesResponse {
    if req.Term < r.currentTerm {
        return &AppendEntriesResponse{Term: r.currentTerm, Success: false}
    }
    if req.Term > r.currentTerm {
        r.becomeFollower(req.Term)
    }
    r.resetElectionTimer() // heartbeat recibido
    // consistency check: mi log en PrevLogIndex debe tener PrevLogTerm
    if req.PrevLogIndex > 0 {
        entry, ok := r.log.get(req.PrevLogIndex)
        if !ok || entry.Term != req.PrevLogTerm {
            return &AppendEntriesResponse{Term: r.currentTerm, Success: false,
                ConflictIndex: r.log.firstIndexOfTerm(entry.Term)}
        }
    }
    r.log.appendAndTruncate(req.PrevLogIndex+1, req.Entries)
    if req.LeaderCommit > r.commitIndex {
        r.commitIndex = min(req.LeaderCommit, r.log.lastIndex())
        r.applyCommittedToStateMachine()
    }
    return &AppendEntriesResponse{Term: r.currentTerm, Success: true}
}
```

Esto es simplificado; una implementación real (hashicorp/raft, etcd/raft) tiene muchos más edge cases (snapshot install, joint consensus para membership changes, log compaction, prevote).

### 2.3 Quorum sizing

Para tolerar `F` fallos simultáneos por crash: `N = 2F + 1`. Quorum = mayoría estricta = `⌈(N+1)/2⌉`.

| N (nodos) | F (tolera) | Quorum |
|---|---|---|
| 3 | 1 | 2 |
| 5 | 2 | 3 |
| 7 | 3 | 4 |
| 9 | 4 | 5 |

Más allá de 7 el trade-off se deteriora: latencia sube linealmente con el número de nodos que deben ackar. Sweet spot en producción: **3 o 5**.

Byzantine fault tolerance (nodos maliciosos): `N = 3F + 1`. PBFT (Castro-Liskov 1999) es la base; blockchains usan variantes (Tendermint, HotStuff) con 100+ validators.

### 2.4 Split-brain y por qué Raft lo previene

Escenario: cluster de 3 nodos Raft. Una network partition aísla al leader A de B y C. B y C eligen a B como nuevo leader (term++). A no sabe que perdió y sigue aceptando writes de clientes que aún pueden alcanzarlo.

¿Por qué no hay corrupción?
- A tiene solo 1 nodo (él mismo) → **no puede committear** (necesita quorum=2). Los writes de A quedan uncommitted → cliente recibe timeout/error.
- B con C tiene quorum=2 → puede committear.
- Cuando la partición sana, A ve un term mayor (del new leader) y **automáticamente se convierte en follower**, descartando sus uncommitted entries.

Availability se pierde en la partición minoritaria (nadie sirve writes); safety se preserva. Es CAP en acción: Raft elige CP.

### 2.5 Leader election en la práctica

Elección basada en Raft con `etcd`:

```bash
# En un cluster etcd de 3 nodos, crear una sesión con TTL
etcdctl lease grant 60           # devuelve LeaseID, p.ej. 694d71ddf1a3c8d3
etcdctl put /service/foo/leader "node-A" --lease=694d71ddf1a3c8d3

# Otro nodo puede intentar adquirir:
etcdctl txn <<EOF
compare("value(/service/foo/leader)" = "")
success = put /service/foo/leader "node-B" --lease=<other-lease>
failure = get /service/foo/leader
EOF
```

Cliente Go usando `concurrency.NewElection`:

```go
package main

import (
    "context"
    "log"
    "time"

    clientv3 "go.etcd.io/etcd/client/v3"
    "go.etcd.io/etcd/client/v3/concurrency"
)

func main() {
    cli, err := clientv3.New(clientv3.Config{
        Endpoints:   []string{"http://etcd1:2379", "http://etcd2:2379", "http://etcd3:2379"},
        DialTimeout: 5 * time.Second,
    })
    if err != nil { log.Fatal(err) }
    defer cli.Close()

    // Sesión con TTL: si el proceso muere, el lease expira y libera el liderazgo
    session, err := concurrency.NewSession(cli, concurrency.WithTTL(15))
    if err != nil { log.Fatal(err) }
    defer session.Close()

    election := concurrency.NewElection(session, "/linguadev/fsrs-worker/leader")
    ctx := context.Background()

    log.Println("Campaigning for leader...")
    if err := election.Campaign(ctx, "worker-1"); err != nil { log.Fatal(err) }

    log.Println("Elected leader")
    // Trabajo exclusivo: consume el topic partition N sin duplicar
    doExclusiveWork(ctx, session)

    // Resign al recibir SIGTERM
    if err := election.Resign(ctx); err != nil { log.Println(err) }
}

func doExclusiveWork(ctx context.Context, s *concurrency.Session) {
    for {
        select {
        case <-ctx.Done():
            return
        case <-s.Done():
            log.Fatal("session expired, we lost leadership")
        default:
            time.Sleep(1 * time.Second)
            // ... trabajo real
        }
    }
}
```

Cuidados: `session.Done()` señala pérdida de sesión (el lease expiró por falta de heartbeat). El código **debe abortar el trabajo exclusivo inmediatamente** para evitar split-brain con el nuevo líder.

---

## 3. Locks distribuidos, leases y fencing (nivel senior)

### 3.1 Por qué los locks distribuidos son peligrosos

Kleppmann (2016) desmontó Redlock con este escenario:

```
t=0    Client A adquiere lock (TTL=10s)
t=1    Client A empieza a escribir a storage
t=3    Client A entra en GC pause
t=13   TTL expira, otro cliente B adquiere el lock
t=14   Client B empieza a escribir
t=15   Client A despierta del GC, "aún tiene el lock" y sigue escribiendo
       ⇒ dos writers concurrentes, corruption
```

El problema es fundamental: cualquier lock con TTL sufre de client pause (GC, VM suspension, network partition prolongada). Aumentar el TTL solo desplaza la ventana; reducirlo aumenta spurious expirations bajo variabilidad normal.

Redlock intentó paliarlo con quorum de 5 Redis masters, pero:
1. Clock jumps (NTP correction) invalidan los TTLs comparados.
2. GC pauses > TTL siguen permitiendo split.
3. Redlock **no expone un fencing token**.

### 3.2 Fencing tokens

**Solución** (Chubby 2006, Google): al adquirir el lock, el servicio devuelve un número monotónico creciente (el "sequencer"). El cliente incluye ese token en toda operación sobre el recurso. El recurso **valida** el token: rechaza operaciones con token < último visto.

```
Client A adquiere → token=42
Client A GC pause
TTL expira, Client B adquiere → token=43
Client B escribe con token=43 → storage acepta (43 > último visto)
Client A despierta, escribe con token=42 → storage rechaza (42 < 43)
```

Requisitos:
- El servicio de lock debe **generar** tokens monotónicos (ZooKeeper `zxid`, etcd `revision`, Chubby sequencer).
- El **recurso destino** debe **validar** el token. Muchos no lo soportan nativos: S3 puro no; hay que envolverlo con proxy o naming (`file-v43.parquet` en lugar de `file.parquet`).

En etcd, cada write devuelve una `revision`. Un cliente puede usar `mod_revision` como fencing token con `Compare(mod_revision(key) = expected)`.

```go
// etcd: fencing con Compare-And-Swap sobre mod_revision
resp, err := cli.Txn(ctx).
    If(clientv3.Compare(clientv3.ModRevision("/critical/resource"), "=", fencingToken)).
    Then(clientv3.OpPut("/critical/resource", newValue)).
    Commit()
if err != nil || !resp.Succeeded {
    // otro cliente adquirió; abortar
    return errStaleToken
}
```

Kafka `leader epoch` (KIP-101, 2017) es fencing token: previene que un zombie leader committee writes tras una election.

### 3.3 Leader lease vs heartbeat

Un mecanismo puramente basado en heartbeat es vulnerable a GC pauses del leader: si el heartbeat se demora > timeout, los followers eligen new leader; cuando el old leader despierta, no sabe que perdió y sigue escribiendo.

**Leader lease** resuelve esto:
- El leader tiene un lease válido por T segundos (p.ej. 10 s).
- Debe **renovar activamente** antes de que expire.
- Puede aceptar writes **solo si el lease no ha expirado**, comparando su reloj local.
- Los followers dan un grace period (T + delta) antes de elegir a otro.
- El old leader que despierta post-expire checkea su lease → inválido → step down sin escribir.

Requiere clock skew acotado (típicamente sub-segundo con NTP correcto). Google Chubby, Spanner (con TrueTime), Aurora, etcd usan variantes.

### 3.4 Bash: reproducir el escenario del pause

Simplificado, para intuición:

```bash
#!/usr/bin/env bash
# demo-split.sh — muestra por qué necesitas fencing token
set -euo pipefail

TOKEN_A=$(etcdctl lease grant 5 | awk '{print $2}')
etcdctl put /shared/resource "written-by-A" --lease="$TOKEN_A"
echo "A adquirió (lease=$TOKEN_A). Pausando 8 s (simula GC)..."
sleep 8

TOKEN_B=$(etcdctl lease grant 5 | awk '{print $2}')
etcdctl put /shared/resource "written-by-B" --lease="$TOKEN_B"
echo "B adquirió (lease=$TOKEN_B)"

echo "A despierta y quiere escribir con su lease $TOKEN_A..."
if etcdctl put /shared/resource "A-writes-again" --lease="$TOKEN_A" 2>&1 | grep -q "requested lease not found"; then
  echo "OK: etcd rechazó porque el lease de A expiró."
else
  echo "ERROR: A pudo escribir; ha ocurrido split-brain."
fi
```

En un entorno real (recurso externo tipo S3), esta protección se pierde salvo que **enforcemos el fencing token en la aplicación** que hace el side effect.

---

## 4. Coordinación avanzada (nivel staff)

### 4.1 Election storms y Pre-Vote

Bajo network flapping (particiones intermitentes de 200 ms), un cluster mal tuneado puede entrar en *election storm*: constantes leader elections, no progreso, CPU al 100%. Mecanismos preventivos:

- **Pre-Vote optimization** (Ongaro thesis §9.6): antes de incrementar term y comenzar election, el candidate hace pre-vote hipotético. Si no obtiene mayoría de yes, no incrementa term (evita disrupcionar leadership vigente). Adoptado en etcd, TiKV, Consul.
- **Randomized election timeouts**: 150-300 ms randomizados; evita split votes cuando múltiples candidates lanzan simultáneamente.
- **Leader stickiness / CheckQuorum**: el leader confirma periódicamente que aún tiene contacto con quorum; si no, step down. Evita que un leader "particionado" siga creyéndose leader.

Bug real: etcd 2015 (issue #3866) tenía election storms bajo network chaos; el fix fue Pre-Vote. Kafka KRaft implementa Pre-Vote desde el inicio (aprendió de etcd).

### 4.2 Gossip protocols

Alternativa a consensus fuerte cuando **no necesitas consistency estricta**, solo propagar información eventualmente. Cada nodo periódicamente selecciona `k` peers aleatorios y les manda su estado; información se propaga en `O(log N)` rondas.

Uso típico:
- **Membership** (SWIM, HashiCorp Serf, Consul LAN gossip): "quién está vivo".
- **Cluster metadata** (Cassandra, ScyllaDB, Riak): schemas, topología.
- **Failure detection** (Phi Accrual, Cassandra): cada nodo mantiene ventana de heartbeats de cada peer y computa una "probabilidad" de que esté muerto.

Ventajas: escalable a miles de nodos, robusto a fallos, sin single coordinator. Desventajas: sin garantías fuertes (eventual, no total order), difícil debuggear.

### 4.3 Vector clocks y Hybrid Logical Clocks

Wall-clock timestamps no bastan en distribuido: NTP tiene skew de ms a segundos, y "later timestamp" no implica "happens after".

**Vector clock** (Fidge/Mattern 1988): cada nodo tiene un contador; incrementa el suyo en cada evento local; incluye su vector al mandar mensaje; al recibir, hace element-wise max. Dos vectores son comparables si uno domina al otro; incomparables ⇒ concurrentes. Uso: Amazon Dynamo, Riak, Voldemort.

Ejemplo:
```
A: [1,0,0] event ⇒ [2,0,0], envía a B
B: [0,1,0] recibe [2,0,0] ⇒ [2,2,0]
C: [0,0,1] event ⇒ [0,0,2]

¿[2,2,0] vs [0,0,2]?
[2,2,0] no domina [0,0,2] (0<2), y viceversa (0<2) ⇒ CONCURRENTES
```

**Hybrid Logical Clock (HLC)** (Kulkarni et al. 2014): combina wall-clock (NTP) con contador lógico. Timestamp = `(physicalTime, logicalCounter)`. Al recibir mensaje con HLC mayor, ajusta. Ventajas: timestamps casi wall-clock (útil para humans), respetan causalidad (Lamport-like), monótonos por nodo.

Adoptado en CockroachDB (junto con TrueTime-like), YugabyteDB, MongoDB 4.2+ ($clusterTime), TiKV. Solución práctica al problema "wall-clock no basta, vector clock no escala".

### 4.4 2PC vs 3PC

**2PC (Two-Phase Commit):**
1. Prepare: coordinator pregunta a todos participants "¿puedes commitear?".
2. Commit/Abort: si todos dijeron sí, coordinator manda commit; si no, abort.

Problemas:
- **Bloqueante**: si el coordinator crashea en fase 2, participants quedan uncertain (pueden haber prepared pero no saben commit/abort).
- **Coordinator SPOF**: sin recovery, participants bloqueados indefinidamente.
- **No tolera Byzantine**.

**3PC (Three-Phase Commit)** intentó resolver el bloqueo añadiendo una fase "canCommit" intermedia. En teoría non-blocking, pero **no funciona con network partitions** (skeen 1982, Bernstein-Newcomer): puede violar safety.

**Práctica en 2026:**
- 2PC clásico (XA transactions) sigue en algunos entornos legacy (Oracle, MSDTC).
- Distribuidos modernos prefieren **saga pattern** (compensaciones aplicativas) sobre 2PC (ver Cap 07 §4.1).
- Sistemas con consensus (Spanner con Paxos, CockroachDB con Raft) hacen commit distribuido con Paxos/Raft en lugar de 2PC.

### 4.5 Cómo eligen ZooKeeper, etcd y Consul

| Aspecto | ZooKeeper | etcd 3.6+ | Consul 1.20 |
|---|---|---|---|
| Lenguaje | Java | Go | Go |
| Consenso | Zab | Raft | Raft |
| API | zNodes jerárquicos | KV + gRPC + leases | KV + service catalog + health + DNS |
| Descubrimiento | No nativo (recipe manual) | No nativo | Sí, first-class |
| Service mesh | No | No | Consul Connect |
| Multi-DC | Complejo | Learners para read replicas | Federation nativa |
| Ecosystem | Hadoop, HBase, Kafka legacy | Kubernetes, CoreDNS, Rook | HashiCorp stack (Vault, Nomad) |
| Operational feel | JVM ops, older tooling | Moderno, cloud-native | Moderno, feature-rich |

Regla operativa:
- **Kubernetes / cloud-native puro** → etcd (ya lo tienes por el control plane).
- **Service discovery + mesh + multi-DC** → Consul.
- **Hadoop/Kafka legacy** → ZooKeeper (pero Kafka 3.x+ ya no lo necesita gracias a KRaft).

etcd 3.6 (mayo 2025) trajo mejoras significativas: reducción de memoria, feature gates estilo Kubernetes, `govulncheck` y Trivy integrados en CI, y transitions más limpias entre release channels. Los patches 3.6.12 y 3.5.31 salieron en junio 2026 con fixes de seguridad menores. etcd 3.7.0-beta (mayo 2026) introduce v3 store definitivo y mejora aún más downgrade support.

### 4.6 Cluster etcd de producción: bootstrap y compose

```yaml
# docker-compose.yaml — cluster etcd 3.6 de 3 nodos
version: "3.9"
services:
  etcd1:
    image: bitnami/etcd:3.6.12
    environment:
      - ALLOW_NONE_AUTHENTICATION=yes
      - ETCD_NAME=etcd1
      - ETCD_ADVERTISE_CLIENT_URLS=http://etcd1:2379
      - ETCD_LISTEN_CLIENT_URLS=http://0.0.0.0:2379
      - ETCD_INITIAL_ADVERTISE_PEER_URLS=http://etcd1:2380
      - ETCD_LISTEN_PEER_URLS=http://0.0.0.0:2380
      - ETCD_INITIAL_CLUSTER=etcd1=http://etcd1:2380,etcd2=http://etcd2:2380,etcd3=http://etcd3:2380
      - ETCD_INITIAL_CLUSTER_TOKEN=linguadev-cluster
      - ETCD_INITIAL_CLUSTER_STATE=new
      - ETCD_ENABLE_PRE_VOTE=true
    ports: ["2379:2379"]
  etcd2:
    image: bitnami/etcd:3.6.12
    environment: [ ... análogo con etcd2 ... ]
  etcd3:
    image: bitnami/etcd:3.6.12
    environment: [ ... análogo con etcd3 ... ]
```

Verificación:
```bash
etcdctl --endpoints=http://localhost:2379 endpoint status --write-out=table
etcdctl --endpoints=http://localhost:2379 endpoint health
etcdctl --endpoints=http://localhost:2379 member list
```

Chaos test: parar `etcd1`, verificar que el cluster sigue serviciando escrituras (2 de 3 = quorum).

### 4.7 Coordination vs database

Un anti-patrón frecuente es usar ZooKeeper/etcd como base de datos. **NO**. Están diseñados para:
- Valores pequeños (KB, no MB).
- Escrituras poco frecuentes.
- Read-heavy workloads.
- Configuración, coordinación, discovery, leader election, feature flags.

**NO** para:
- User data (millones de rows).
- Blobs.
- Time series.
- Escrituras a alta frecuencia.

Cada write en etcd es un round-trip a través de Raft con fsync. Latencia ~5-20 ms típica; throughput ~10k writes/s max. Cassandra o DynamoDB manejan órdenes de magnitud más.

---

## 5. Ejemplo práctico completo: leader election para el FSRS scheduler de LinguaDev Pro

En LinguaDev Pro un scheduler periódico calcula, para cada usuario activo, cuántas tarjetas están debidas y envía push notifications. Debe correr como **singleton** (un solo pod activo a la vez) para evitar duplicar notificaciones. Solución: leader election con etcd.

### Paso 1: cluster etcd

```bash
docker compose -f infra/etcd-cluster.yml up -d
etcdctl --endpoints=http://localhost:2379,http://localhost:2380,http://localhost:2381 \
  endpoint health --write-out=table
```

### Paso 2: worker con leader election

```go
// packages/scheduler/main.go
package main

import (
    "context"
    "log/slog"
    "os"
    "os/signal"
    "syscall"
    "time"

    clientv3 "go.etcd.io/etcd/client/v3"
    "go.etcd.io/etcd/client/v3/concurrency"
)

const (
    electionKey = "/linguadev/scheduler/leader"
    ttlSeconds  = 15
)

func main() {
    log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
    ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
    defer cancel()

    cli, err := clientv3.New(clientv3.Config{
        Endpoints: []string{"etcd1:2379", "etcd2:2379", "etcd3:2379"},
        DialTimeout: 5 * time.Second,
    })
    if err != nil { log.Error("etcd connect", "err", err); os.Exit(1) }
    defer cli.Close()

    hostname, _ := os.Hostname()

    for {
        if err := runAsLeader(ctx, cli, hostname, log); err != nil {
            log.Error("leader loop", "err", err)
        }
        if ctx.Err() != nil { return }
        time.Sleep(2 * time.Second)
    }
}

func runAsLeader(ctx context.Context, cli *clientv3.Client, name string, log *slog.Logger) error {
    session, err := concurrency.NewSession(cli, concurrency.WithTTL(ttlSeconds))
    if err != nil { return err }
    defer session.Close()

    election := concurrency.NewElection(session, electionKey)
    log.Info("campaigning", "id", name)
    if err := election.Campaign(ctx, name); err != nil { return err }
    log.Info("elected", "id", name)

    // Al perder sesión (network partition, etcd crash local, GC del cliente > TTL) abortamos work
    workCtx, cancelWork := context.WithCancel(ctx)
    defer cancelWork()

    go func() {
        select {
        case <-session.Done():
            log.Warn("session expired, revoking leadership")
            cancelWork()
        case <-ctx.Done():
        }
    }()

    return runScheduler(workCtx, log)
}

func runScheduler(ctx context.Context, log *slog.Logger) error {
    ticker := time.NewTicker(1 * time.Minute)
    defer ticker.Stop()
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case t := <-ticker.C:
            log.Info("scheduling due cards", "at", t)
            if err := scheduleDueCards(ctx); err != nil {
                log.Error("schedule", "err", err) // no exit; retry siguiente tick
            }
        }
    }
}

func scheduleDueCards(ctx context.Context) error {
    // consulta DynamoDB para users con reviews debidas, envía SNS notifications
    // ...
    return nil
}
```

### Paso 3: Kubernetes deployment de 3 réplicas

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: fsrs-scheduler, namespace: linguadev }
spec:
  replicas: 3
  strategy: { type: RollingUpdate, rollingUpdate: { maxUnavailable: 1, maxSurge: 0 } }
  selector: { matchLabels: { app: fsrs-scheduler } }
  template:
    metadata: { labels: { app: fsrs-scheduler } }
    spec:
      containers:
      - name: scheduler
        image: linguadev/fsrs-scheduler:1.4.0
        env:
        - { name: ETCD_ENDPOINTS, value: "etcd1:2379,etcd2:2379,etcd3:2379" }
        readinessProbe:
          httpGet: { path: /ready, port: 8080 }
        livenessProbe:
          httpGet: { path: /live, port: 8080 }
        resources:
          requests: { cpu: "100m", memory: "128Mi" }
          # sin CPU limit (ver Cap 09 §4)
          limits:   { memory: "256Mi" }
```

Con 3 réplicas y leader election en etcd, **solo una hace trabajo**; las otras dos son standby. Si la activa cae (pod crash, node NotReady, deploy rolling), el lease expira en ≤ 15 s y otra toma leadership. Rolling update es seguro: al terminar el pod líder, `election.Resign()` en el signal handler libera inmediatamente.

### Paso 4: validar el behavior bajo caos

```bash
# 1. Ver cuál es el leader
etcdctl get /linguadev/scheduler/leader --prefix --write-out=json | jq '.kvs[0].value | @base64d'

# 2. Kill del leader pod y ver failover
kubectl delete pod -n linguadev $(kubectl get pods -n linguadev -l app=fsrs-scheduler -o name | head -1) --grace-period=0 --force

# 3. Observar logs: otra réplica se convierte en leader en < 15 s
kubectl logs -n linguadev -l app=fsrs-scheduler --tail=50 -f

# 4. Chaos: partición de red al leader (con tc netem si es sandbox)
kubectl exec -n linguadev $LEADER_POD -- tc qdisc add dev eth0 root netem loss 100%
# Debe: leader pierde sesión, cancela work, otra réplica toma leadership
```

### Paso 5: monitoreo

Métricas Prometheus obligatorias:
- `scheduler_leader{pod="..."} 1|0`
- `scheduler_leader_transitions_total` (contador; incremento anormal ⇒ flapping)
- `etcd_lease_ttl_seconds` (histograma)
- `scheduler_scheduling_iterations_total`

Alarma: `rate(scheduler_leader_transitions_total[5m]) > 1` ⇒ investigar election storm.

---

## 6. Cheatsheet + reglas mentales + anti-patrones

### Reglas de oro

- ✅ Todo consensus protocol práctico usa timeouts (FLP).
- ✅ Cluster de consenso: **3 o 5 nodos**, siempre impar.
- ✅ `N = 2F + 1` para crash tolerance; `N = 3F + 1` para Byzantine.
- ✅ Raft para nuevos deployments (understandability = correctness).
- ✅ Randomized election timeouts + Pre-Vote + CheckQuorum siempre habilitados.
- ✅ Leader lease + fencing tokens para prevenir split-brain post-pause.
- ✅ Fencing tokens validados por el **recurso destino**, no por el lock service.
- ✅ Preferir **evitar** distributed locks: partición por hash, idempotencia, leader election.
- ✅ Coordination services (etcd/ZK/Consul) para configs pequeñas y coordination, **no** como database.
- ✅ HLC (CockroachDB, YugabyteDB, MongoDB) para timestamps que respeten causalidad.
- ✅ Al perder sesión etcd/ZK, **abortar inmediatamente** el trabajo exclusivo.
- ✅ Monitor consumer lag, leader transitions, election frequency como SLIs.

### Anti-patrones

- ❌ Confiar en wall-clock para ordering distribuido.
- ❌ Redlock (o cualquier lock con TTL) sin fencing token para operaciones críticas.
- ❌ 2PC clásico para nuevas arquitecturas distribuidas (usa sagas).
- ❌ ZooKeeper/etcd como base de datos de usuarios.
- ❌ Cluster de consenso par (4 nodos = misma tolerancia que 3, más latencia).
- ❌ Cluster de consenso > 7 nodos "para más HA" (latencia sube, sin ganancia real).
- ❌ Ignorar GC pauses del líder ("no ocurren en producción").
- ❌ Global ordering resuelto con `partitions=1` (Kafka) o cluster single-node (mata scale).
- ❌ Duplicar coordination infrastructure (ZK + etcd + Consul juntos).

### Tabla de decisión: qué coordination service usar

| Contexto | Elección |
|---|---|
| Kubernetes control plane / cloud-native puro | etcd 3.6+ |
| Service discovery + mesh + multi-DC | Consul 1.20 |
| Hadoop, HBase, Kafka pre-3.x | ZooKeeper |
| Kafka 3.x+ nuevo | KRaft (Kafka propio, sin ZK) |
| Feature flags globales + leader election de workers | etcd o Consul |
| Coordinación multi-region estricta (banca, financials) | Spanner-like (TrueTime, Paxos) |
| Blockchain / trust-less | BFT (Tendermint, HotStuff) |

---

## 7. Casos reales industria 2018-2026

**GitHub MySQL Orchestrator split-brain (oct 2018):** GitHub sufrió 24h de degraded service tras una network partition. Orchestrator (usaba Raft-like leader election para failover) tuvo split-brain porque el fencing token entre Orchestrator y MySQL no estaba alineado tras la particion. Post-mortem público en el blog de GitHub. **Lección:** fencing entre el lock service y el recurso destino tiene que ser end-to-end, no assumido.

**Cloudflare BGP + leader election outage (jul 2020):** una asunción sobre leadership sin proper fencing en su router configuration llevó a black-holing global de 27 minutos. **Lección:** los sistemas críticos que asumen leadership deben validar contra un fencing token cada operación, no confiar en heartbeat.

**Kafka migra a KRaft (2021-2025):** KIP-500 propuso eliminar ZooKeeper de Kafka. Producción-ready desde 3.5 (2023), default en 3.7 (2024), ZooKeeper deprecated en 3.9 (2024) y **removed en Kafka 4.0** (2025). Simplifica operations, reduce dependency, mejora startup time. **Lección:** protocolos consensus modernos (Raft) están reemplazando incumbents (Zab) por understandability y operational simplicity.

**etcd bug hunt con Jepsen (Aphyr, varios años):** Kyle Kingsbury (Aphyr) sometió etcd, Consul, CockroachDB, TiDB a los tests Jepsen. etcd sobrevivió casi todos gracias a implementación correcta de Raft con TLA+ verified. Bugs históricos: etcd 2.3 tuvo issue de linearizability bajo network chaos, fixed. **Lección:** verificación formal (TLA+) + testing chaos (Jepsen) son prácticas obligatorias en cualquier consensus system serio.

**Kleppmann vs Antirez sobre Redlock (2016):** debate público de Kleppmann analyzing Redlock y Antirez (Salvatore Sanfilippo, creador de Redis) defendiéndolo. Consenso técnico posterior: Redlock no es safe para casos donde se necesita corrección absoluta. **Lección:** Redlock para *best-effort* mutual exclusion OK; para correctness use fencing tokens con recurso cooperativo.

**Google Chubby (paper 2006, Burrows):** primer coordination service masivo (usado por GFS, MapReduce, Bigtable). Introduce leases + fencing sequencers. Referencia obligada para entender lo que ZooKeeper y etcd hicieron después.

**CockroachDB & TrueTime-inspired HLC (2015+):** CockroachDB usa HLC para timestamps que respeten causalidad sin necesitar hardware especializado (Spanner requiere GPS/atomic clocks para TrueTime). Serializable isolation entre datacenters. **Lección:** HLC es "TrueTime del pobre" y suficiente para 99% de casos.

**MongoDB 5.0+ shard-level Raft:** MongoDB adoptó Raft-like para replica set elections y para config server consensus. Migración desde su protocolo custom. **Lección:** todos los DBs distribuidos serios convergen a Raft o Paxos.

**etcd 3.6 (mayo 2025):** primer minor desde 3.5 (2021), 4 años de trabajo. Introduce feature gates estilo Kubernetes, downgrade support, memoria reducida, `govulncheck` + trivy en CI. Patches 3.6.12 en jun 2026. etcd 3.7-beta (mayo 2026) trae v3 store definitivo.

---

## 8. Ejercicios prácticos

### Ejercicio 1: montar cluster etcd de 3 nodos y validar quorum

**Objetivo:** entender empíricamente qué significa `N = 2F + 1`.

**Setup:**
- Docker + docker-compose.
- `etcdctl` local (`brew install etcd`).

**Pasos:**
1. Copia el compose del §4.6 y arráncalo: `docker compose up -d`.
2. Verifica health con `etcdctl endpoint health --endpoints=...`.
3. Ejecuta `etcdctl put /test/key "value1"` y `etcdctl get /test/key` — ambas deben funcionar.
4. Para el nodo 3 (`docker stop etcd3`). Verifica que puts/gets siguen funcionando (quorum=2 con 2 nodos vivos).
5. Para el nodo 2 (`docker stop etcd2`). Verifica que `etcdctl put` **falla o cuelga** (sin quorum).
6. Levanta etcd2 y observa el recovery en logs (`docker logs etcd2 -f`).

**Criterios de éxito:**
- [ ] Con 3/3 nodos, R/W funciona.
- [ ] Con 2/3, R/W funciona.
- [ ] Con 1/3, W falla con `context deadline exceeded` o `no leader`.
- [ ] Recovery limpio al restaurar el segundo nodo.
- [ ] Documentado el output de cada paso.

**Bonus:** con `etcdctl move-leader` fuerza cambio de leader y observa que no hay downtime perceptible.

---

### Ejercicio 2: leader election con etcd + failover automático

**Objetivo:** implementar el patrón scheduler singleton del §5.

**Setup:**
- Cluster etcd del Ejercicio 1.
- Go 1.22 (o Python con `python-etcd3`).

**Pasos:**
1. Escribe el código Go del §5 en un archivo `main.go`.
2. Compila y arranca 3 instancias (`./scheduler` en 3 terminales).
3. Observa en logs cuál es el elected leader.
4. Mata el proceso leader con Ctrl+C. Observa: en < 15 s (TTL del lease), otra instancia se elige.
5. Mata también el nuevo leader. La tercera instancia toma leadership.
6. Documenta el tiempo real de failover en cada iteración (log del `elected` timestamp).

**Criterios de éxito:**
- [ ] Solo una instancia hace trabajo activo a cada momento.
- [ ] Failover < 15 s tras kill del leader.
- [ ] `Resign()` en signal handler libera leadership inmediatamente (failover < 1 s con SIGTERM).
- [ ] Al perder sesión, el trabajo exclusivo se cancela (test: bloquea la red al leader con `tc` y observa).
- [ ] Métricas Prometheus expuestas (leader gauge, transitions counter).

**Bonus:** integra un test end-to-end con `dockertest` que valide el failover automáticamente.

---

### Ejercicio 3: fencing tokens con etcd y storage cooperativo

**Objetivo:** implementar exclusión mutua **safe** con fencing token validado en el recurso destino.

**Setup:**
- etcd del Ejercicio 1.
- Postgres o SQLite como "recurso cooperativo".

**Pasos:**
1. Diseña tabla `resource_lock (key TEXT PRIMARY KEY, last_token BIGINT)`.
2. En el cliente: al adquirir lock en etcd, obtén `mod_revision` como token.
3. Cada write al recurso: `UPDATE resource SET ... WHERE key = $1 AND last_token <= $2`. Si `rowCount = 0`, aborta (token stale).
4. Simula pause con `time.Sleep(30 * time.Second)` en el "cliente A" tras adquirir; el TTL expira en 15 s.
5. Levanta un "cliente B" que adquiere el lock y escribe con su token.
6. El cliente A despierta e intenta escribir con su token viejo. **Debe ser rechazado.**

**Criterios de éxito:**
- [ ] Cliente B escribe correctamente su valor.
- [ ] Cliente A recibe error de token stale, no corrompe.
- [ ] Test automatizado que reproduce el escenario y falla si el fencing no funciona.
- [ ] Documenta qué pasaría **sin** fencing token (spoiler: silent overwrite).

**Bonus:** implementa un proxy S3 que valide fencing tokens antes de PUT, encapsulando así S3 puro como "recurso cooperativo".

---

### Ejercicio 4: simular election storm y aplicar Pre-Vote

**Objetivo:** entender por qué Pre-Vote es esencial bajo network flapping.

**Setup:**
- Cluster etcd de 5 nodos (extiende el compose).
- `tc netem` en Linux para simular packet loss.

**Pasos:**
1. Verifica cluster healthy: 5/5 nodos, un leader estable.
2. Aplica en el leader: `tc qdisc add dev eth0 root netem loss 50% delay 100ms 50ms`.
3. Observa logs: si Pre-Vote está deshabilitado (etcd flag `--enable-pre-vote=false`), verás elecciones repetidas.
4. Cambia a `--enable-pre-vote=true` (default en etcd 3.6+). Repite el experimento.
5. Compara métricas `etcd_server_leader_changes_seen_total` en ambos casos.
6. Documenta la diferencia con gráficos de Grafana.

**Criterios de éxito:**
- [ ] Sin Pre-Vote: > 10 leader changes en 5 min bajo chaos.
- [ ] Con Pre-Vote: < 2 leader changes en el mismo periodo.
- [ ] Alerta configurada: `rate(etcd_server_leader_changes_seen_total[5m]) > 0.1`.
- [ ] Runbook documentado con pasos para detectar y mitigar election storms.

**Bonus:** repite con `CheckQuorum` desactivado y observa el efecto complementario.

---

### Ejercicio 5 (bonus): implementar Raft mini en Go

**Objetivo:** entender Raft profundamente escribiendo una implementación educativa.

**Setup:**
- Go 1.22.
- Fork o consulta de `hashicorp/raft` o `etcd/raft` para referencia.

**Pasos:**
1. Implementa estructuras: `RaftState`, `LogEntry`, `RequestVoteRPC`, `AppendEntriesRPC`.
2. Implementa transiciones follower ↔ candidate ↔ leader con election timeout randomizado.
3. Implementa log replication con consistency check (`PrevLogIndex`, `PrevLogTerm`).
4. Implementa la commit rule (majority replicated).
5. Test suite: cluster de 3 nodos, elecciones normales, network partition, recovery.
6. Sigue el paper de Raft (secciones 5.1-5.4) como spec.

**Criterios de éxito:**
- [ ] Elecciones convergen en < 1 s bajo condiciones normales.
- [ ] Bajo partición, minoría no committea; mayoría sí.
- [ ] Al sanar partición, minoría se sincroniza con el log del leader.
- [ ] Sin bugs de safety (no dos leaders con quorum simultáneos en ningún test).

**Bonus:** añade snapshotting cuando el log crezca > 10k entries.

---

## 9. Recursos + siguientes pasos

**Papers seminales:**
- Fischer, Lynch, Paterson — *Impossibility of Distributed Consensus with One Faulty Process*, JACM 1985.
- Lamport — *The Part-Time Parliament*, TOCS 1998.
- Lamport — *Paxos Made Simple*, 2001.
- Ongaro & Ousterhout — *In Search of an Understandable Consensus Algorithm*, ATC 2014.
- Ongaro — *Consensus: Bridging Theory and Practice*, tesis Stanford 2014.
- Burrows — *The Chubby lock service for loosely-coupled distributed systems*, OSDI 2006.
- Castro & Liskov — *Practical Byzantine Fault Tolerance*, OSDI 1999.
- Kulkarni et al. — *Logical Physical Clocks and Consistent Snapshots in Globally Distributed Databases*, 2014.

**Libros:**
- Kleppmann — *Designing Data-Intensive Applications*, caps. 8 y 9.
- Cachin, Guerraoui, Rodrigues — *Introduction to Reliable and Secure Distributed Programming*.

**Blogs y charlas:**
- Kleppmann — *How to do distributed locking* (2016).
- Kleppmann — *Please stop calling databases CP or AP* (2015).
- Aphyr (Kyle Kingsbury) — todos los reportes de Jepsen sobre etcd, Consul, CockroachDB.
- Ongaro — [The Raft Consensus Algorithm](https://raft.github.io/).
- Diego Ongaro — video "Raft User Study".

**Frameworks y herramientas:**
- [etcd 3.6](https://etcd.io/) — Raft en Go, control plane K8s.
- [Consul 1.20](https://www.consul.io/) — Raft + service mesh.
- [hashicorp/raft](https://github.com/hashicorp/raft) — biblioteca Raft en Go.
- [etcd-io/raft](https://github.com/etcd-io/raft) — implementación de referencia embebible.
- [TLA+](https://lamport.azurewebsites.net/tla/tla.html) — spec formal (Lamport), usado para verificar Raft.
- [Jepsen](https://jepsen.io/) — framework de tests de consistencia distribuida.
- [CockroachDB](https://www.cockroachlabs.com/) — SQL distribuido con Raft + HLC.

**Siguientes pasos:**
- Aplica el patrón de leader election del §5 a tu propio worker singleton.
- Añade un chaos test a tu CI: mata un pod etcd cada N minutos y verifica que tu app aguanta.
- Lee [Cap 09 — patrones cloud-native](./09-patrones-cloud-native.md) para orquestar etcd y Consul en Kubernetes, y para entender por qué el operator pattern es la forma correcta de deploar coordination services stateful.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales, dificultades mid → staff. Cubren: teorema FLP y su implicación en timeouts, por qué Raft ganó a Paxos, split-brain y quorum, sizing `2F+1`, comparación ZooKeeper vs etcd vs Consul, peligros de los distributed locks, leader lease vs heartbeat, fencing tokens y cooperación del recurso, election storms y Pre-Vote, consenso vs coordination vs database, gossip protocols, vector clocks y HLC, 2PC vs 3PC y por qué prefiere sagas, Byzantine fault tolerance (`3F+1`), KRaft y la migración desde ZooKeeper, TrueTime y HLC en distributed SQL, cluster sizing práctico, monitoring de leader transitions, chaos engineering y validación con Jepsen, y anti-patrones frecuentes de coordination.

- **Fuente:** [`packages/content/src/tech/architecture/sim-08-consensus-and-coordination.json`](../../packages/content/src/tech/architecture/sim-08-consensus-and-coordination.json)
- **Ruta en app:** `/programming/architecture/sim/architecture-sim-08-consensus-and-coordination`
- **Tiempo:** 28 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 07 — Event Sourcing y CQRS](./07-event-sourcing-y-cqrs.md) · [Índice](./README.md) · [Capítulo 09 — patrones cloud-native →](./09-patrones-cloud-native.md)

# Capítulo 02 — SOLID, patrones y anti-patrones

> **Focus:** Aplicación real de SOLID en decisiones concretas de diseño, cuándo un patrón es útil y cuándo es sobre-ingeniería, y cómo distinguir el olor genuino del pattern-worship.
> **Áreas:** OOP y SOLID · Patrones de diseño · Refactor
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 22 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Familiaridad con al menos un lenguaje OOP: Java, C#, Kotlin, Python o TypeScript.
- Fundamentos del [cap 01 — fundamentos y complejidad](./01-fundamentos-y-complejidad.md) (elección de estructura, encapsulamiento intuitivo).
- Haber leído o escrito código de negocio no trivial (>1000 líneas propias en algún proyecto).

**Glosario mínimo:**
- **SOLID:** acrónimo de Single Responsibility, Open/Closed, Liskov Substitution, Interface Segregation y Dependency Inversion. Robert C. Martin, 2000.
- **Tell, Don't Ask:** en vez de preguntar por el estado y decidir fuera, dile al objeto qué haga.
- **YAGNI:** *You Aren't Gonna Need It*. No construyas para requisitos hipotéticos.
- **Rule of Three (Fowler):** duplica una vez, refactoriza en el tercer uso.
- **Fragile Base Class:** cuando cambios en la superclase rompen subclases silenciosamente.
- **DTO vs Entity:** DTO transporta datos entre capas; Entity captura lógica del dominio con invariantes.
- **God Class / God Object:** clase que absorbe múltiples responsabilidades hasta ser inmantenible.
- **Anemic Domain Model:** entities con solo getters/setters y lógica en services procedurales — OOP disfrazado de estructural.

**Setup mínimo (2026):**

```bash
# Herramientas de análisis estático
sonarqube --version         # 10.6+ (o SonarCloud)
pip install radon           # complejidad ciclomática Python
npm i -D eslint-plugin-sonarjs
mvn com.github.spotbugs:spotbugs-maven-plugin:check   # bugs comunes Java

# Refactor asistido
# IntelliJ IDEA 2026.x, VS Code + refactorings, ReSharper
# GitHub Copilot Chat "explain this class"
```

---

## 1. El gran cuadro

En 2000, Robert C. Martin agrupó cinco principios ya circulantes (Meyer, Liskov, Barbara Liskov, Uncle Bob mismo) bajo el acrónimo SOLID. Veintitantos años después, siguen siendo el vocabulario común en cualquier code review serio. No porque sean sagrados — de hecho, cada uno se ha malinterpretado hasta el ridículo — sino porque nombran problemas reales que aparecen una y otra vez: clases que cambian por demasiadas razones, jerarquías rígidas, interfaces gordas, dependencias en la dirección equivocada. Si en un PR alguien dice "esto viola SRP" o "aquí Liskov se rompe", debes entender exactamente qué está señalando.

Los patrones de diseño (Gang of Four, 1994) son el segundo pilar de este capítulo. Son soluciones catalogadas a problemas recurrentes. También son la fuente más común de sobre-ingeniería en proyectos jr: aplicar Factory + Strategy + Observer donde bastaba una función. Un senior sabe cuándo un patrón es la respuesta y cuándo es un adorno que multiplica indirection sin propósito. La regla de oro es que los patrones nacen del segundo o tercer uso, no del primero: una abstracción diseñada con un solo caso en mente es una adivinación, y las adivinaciones envejecen mal.

El tercer eje son los anti-patrones. Nombrarlos ayuda a diagnosticar código enfermo con precisión: "esto es un God Class", "aquí tenemos un Anemic Domain Model", "esto es Speculative Generality". Cada uno viene con estrategia de refactor incremental. El anti-patrón meta más peligroso es el Second System Syndrome — reescribir desde cero un sistema que funciona porque "el código legacy es un desastre". Casi siempre fracasa. Netscape/Mozilla, Basecamp Classic, Digg v4 — la historia está llena de rewrites que hundieron negocios.

Al final del capítulo tendrás dos herramientas: primero, un lenguaje preciso para señalar problemas en code review sin ser vago ("SRP violation por acoplamiento a tres actores distintos" en lugar de "esto huele mal"); segundo, criterio para saber cuándo introducir un patrón y cuándo dejar código simple. El objetivo NO es aplicar más patrones — es aplicar menos, mejor.

---

## 2. Fundamentos (nivel básico)

### 2.1 Encapsulamiento genuino vs JavaBean anémico

La definición de manual — "campos privados con getters y setters" — es incorrecta. Un objeto con getters/setters para todo su estado interno NO está encapsulado: expone su representación. Cualquier cambio interno (renombrar un campo, cambiar tipo, migrar de `List` a `Set`) rompe todos los clientes.

Encapsulamiento genuino significa **ocultar la representación interna y exponer solo comportamiento relevante**.

```java
// ANTI: getters/setters expuestos. El cliente orquesta el estado.
public class Order {
    private OrderStatus status;
    public OrderStatus getStatus() { return status; }
    public void setStatus(OrderStatus s) { this.status = s; }
}

// Uso desde fuera:
if (order.getStatus() == OrderStatus.PAID) {
    order.setStatus(OrderStatus.SHIPPED);
}
```

```java
// BIEN: comportamiento. El cliente pide una acción; el objeto valida y decide.
public class Order {
    private OrderStatus status;

    public void markAsShipped() {
        if (status != OrderStatus.PAID) {
            throw new IllegalStateException("Cannot ship unpaid order");
        }
        this.status = OrderStatus.SHIPPED;
        recordEvent(new ShippedEvent(this.id));
    }
}

order.markAsShipped();   // Tell, Don't Ask
```

Consecuencia: puedes cambiar `status` de un enum simple a una máquina de estados con transiciones auditadas sin tocar clientes. Puedes añadir invariantes, logging, eventos. Los clientes no saben nada.

Cuándo los getters SON aceptables:
- **DTOs / Value Objects / Records** — no tienen comportamiento, solo transportan datos.
- **Projections read-only** para vistas o APIs.
- **Serialización** — a veces el framework necesita accessors.

En Java 14+, `record` genera getters + `equals` + `hashCode` + `toString` para value objects. En Kotlin, `data class`. En C#, `record`. Usarlos donde encajan es correcto; usarlos para entities del dominio genera Anemic Domain Model (ver §4.4).

### 2.2 Herencia vs composición: "favor composition over inheritance"

La comunidad OOP moderna (Gang of Four, Bloch, Fowler) coincide: **favor composition over inheritance**. Herencia tiene tres problemas:

1. **Acoplamiento fuerte a la superclase.** Cambios en el padre afectan al hijo (Fragile Base Class).
2. **Rigidez.** Un objeto tiene un tipo para siempre. Un Employee promovido a Manager no puede cambiar de tipo en runtime.
3. **LSP violation silenciosa.** Muchas "es-un" relaciones del mundo real no son relaciones de tipo.

Composición: el objeto TIENE algo, no ES algo.

```kotlin
// HERENCIA: Employee -> Manager. Rígido.
open class Employee(val name: String, val salary: BigDecimal)
class Manager(name: String, salary: BigDecimal, val team: List<Employee>) : Employee(name, salary)

// COMPOSICIÓN: Employee con roles cambiables.
data class Employee(val name: String, val salary: BigDecimal, val roles: Set<Role>) {
    fun promoteTo(role: Role) = copy(roles = roles + role)
}

sealed interface Role {
    data class Manager(val team: List<Employee>) : Role
    object IndividualContributor : Role
}
```

Kotlin ofrece `by` (delegation nativa) que hace composición trivial:

```kotlin
interface Repository<T> {
    fun findById(id: Long): T?
    fun save(entity: T)
}

class LoggingRepository<T>(
    private val delegate: Repository<T>
) : Repository<T> by delegate {
    override fun save(entity: T) {
        println("saving $entity")
        delegate.save(entity)
    }
}
```

Cuándo herencia SÍ funciona:
- Cuando el "es-un" es INVARIANTE (un `Square` es una `Shape` para siempre; un `LinkedHashSet` es un `HashSet` con orden de inserción).
- Cuando el subtipo cumple LSP estrictamente.
- Para "template method" muy acotado.

### 2.3 Single Responsibility: "una razón para cambiar"

SRP se malinterpreta como "una clase hace una cosa". La formulación correcta (Uncle Bob, revisada 2014+) es: **una clase debe tener una y solo una razón para cambiar, sirviendo a un solo actor**.

Un actor = persona o rol que solicita cambios. Ejemplos:

- Legal → cambia lógica de impuestos.
- Marketing → cambia templates de emails y PDFs.
- Finanzas → cambia estados de facturación.
- Producto → cambia workflow de checkout.

Si tres actores distintos piden cambios sobre la misma clase, tienes tres responsabilidades mezcladas. Divide.

```python
# ANTES: InvoiceService de 800 líneas, cambian legal, marketing y finanzas.
class InvoiceService:
    def calcular_impuestos(self, invoice): ...     # legal
    def generar_pdf(self, invoice): ...            # marketing
    def enviar_email(self, invoice): ...           # marketing
    def actualizar_estado_bd(self, invoice): ...   # finanzas
```

```python
# DESPUÉS: separado por actor.
class TaxCalculator:                # legal
    def calculate(self, invoice) -> Money: ...

class InvoiceRenderer:              # marketing (PDF + email pueden ir juntos)
    def render_pdf(self, invoice) -> bytes: ...
    def render_email_body(self, invoice) -> str: ...

class InvoiceRepository:            # finanzas
    def update_status(self, invoice_id, status): ...

class InvoiceOrchestrator:          # coordina las 3, cambia si el workflow cambia
    def __init__(self, tax, renderer, repo, email_sender):
        self.tax = tax; self.renderer = renderer
        self.repo = repo; self.email = email_sender

    def process(self, invoice):
        invoice.tax = self.tax.calculate(invoice)
        pdf = self.renderer.render_pdf(invoice)
        self.email.send(invoice.customer.email, pdf)
        self.repo.update_status(invoice.id, Status.SENT)
```

Herramienta práctica: mira `git log --follow` sobre el archivo. Si dos métodos siempre aparecen en el mismo commit, están cohesionados. Si nunca aparecen juntos, probablemente son responsabilidades separadas.

### 2.4 Cuándo NO usar un patrón (YAGNI)

Un jr propone: "Añadamos Strategy + Factory + Abstract Factory para el envío de notificaciones — así podemos añadir SMS y push más adelante sin cambiar código". Estimación: 3 días.

Hoy solo hay email. No hay ticket para SMS. Nadie sabe si push será relevante.

**Respuesta correcta:** implementar solo email hoy con una firma limpia (`NotificationService.send(user, message)`). Cuando llegue el segundo canal, refactor a Strategy con contexto real. Menos código, menos deuda, decisión informada.

Razones:
- **YAGNI** — Kent Beck. No construir para requisitos hipotéticos.
- **Rule of Three** — Martin Fowler. Duplica una vez, refactoriza en el tercer uso.
- **Speculative generality** — Fowler smell. Interfaces con una sola implementación son casi siempre humo.
- **La abstracción diseñada con un solo caso adivina mal.** Cuando llegue SMS, es probable que la interfaz no encaje.

Excepciones legítimas: introducir un patrón preventivo cuando el requisito futuro está CONFIRMADO por producto Y la refactor posterior sería muy costosa (ej. cambiar contrato público de una librería).

---

## 3. Cómo funciona por dentro (nivel medio)

### 3.1 Open/Closed: polimorfismo en lugar de cascadas de if

**"Una entidad debe estar abierta para extensión, cerrada para modificación."**

Si añadir una feature requiere modificar código existente en múltiples puntos, has violado OCP.

```java
// VIOLA OCP: añadir un tipo nuevo obliga a modificar este método
public BigDecimal calcularDescuento(Customer c) {
    if (c.type == VIP)     return new BigDecimal("0.20");
    if (c.type == GOLD)    return new BigDecimal("0.10");
    if (c.type == REGULAR) return BigDecimal.ZERO;
    throw new IllegalArgumentException("Unknown type");
}
```

Refactor con enum + método abstracto (Java):

```java
public enum CustomerType {
    VIP     { public BigDecimal discount() { return new BigDecimal("0.20"); } },
    GOLD    { public BigDecimal discount() { return new BigDecimal("0.10"); } },
    REGULAR { public BigDecimal discount() { return BigDecimal.ZERO; } };
    public abstract BigDecimal discount();
}

// Añadir STUDENT o SENIOR solo requiere una entry nueva en el enum.
// El código que llama customer.type.discount() no se toca.
```

Alternativas equivalentes:
- Interface + implementaciones por tipo (`DiscountStrategy` con `VipStrategy`, `GoldStrategy`, ...).
- `Map<CustomerType, Function<Customer, BigDecimal>>` — versión funcional.
- Tabla en base de datos (para reglas que cambian sin deploy).

Balance con YAGNI: no polimorfices cada `if`. Solo aquellos que sabes que crecerán o que ya tienen 3+ casos.

### 3.2 Liskov Substitution: el ejemplo canónico

Barbara Liskov (1987): **si `S` es subtipo de `T`, objetos de tipo `T` pueden reemplazarse por objetos de tipo `S` sin alterar propiedades deseadas del programa.**

Formalmente: pre-condiciones no pueden fortalecerse en el subtipo, post-condiciones no pueden debilitarse, invariantes deben preservarse.

El ejemplo canónico es `Square extends Rectangle`:

```java
public class Rectangle {
    protected int width, height;
    public void setWidth(int w)  { this.width = w; }
    public void setHeight(int h) { this.height = h; }
    public int area() { return width * height; }
}

public class Square extends Rectangle {
    @Override public void setWidth(int w)  { this.width = w; this.height = w; }
    @Override public void setHeight(int h) { this.width = h; this.height = h; }
}

@Test
void areaTest() {
    Rectangle r = new Square();
    r.setWidth(5);
    r.setHeight(4);
    assertEquals(20, r.area());   // FAIL: da 16
}
```

`Square` viola el contrato heredado de `Rectangle` que promete "setWidth cambia solo width". Aunque "un cuadrado ES un rectángulo" en matemáticas, la herencia de TIPO requiere sustitución sin sorpresa.

Fix: `Square` y `Rectangle` no comparten herencia; ambos implementan `Shape` con `area()`.

```java
public sealed interface Shape permits Rectangle, Square {
    int area();
}
public record Rectangle(int width, int height) implements Shape {
    public int area() { return width * height; }
}
public record Square(int side) implements Shape {
    public int area() { return side * side; }
}
```

Otro caso: `Stack extends Vector` en Java. `Stack` hereda `add(index, element)` que rompe la invariante LIFO. Bloch lo cita en *Effective Java* como ejemplo de mala herencia.

### 3.3 Interface Segregation: interfaces pequeñas y cohesivas

**"Clientes no deben depender de métodos que no usan."**

```java
// VIOLA ISP: interfaz gorda
public interface Worker {
    void work();
    void eat();
    void sleep();
}

public class Robot implements Worker {
    public void work()  { /* ... */ }
    public void eat()   { throw new UnsupportedOperationException(); }
    public void sleep() { throw new UnsupportedOperationException(); }
}
```

Lanzar excepción viola ISP y LSP a la vez. Fix — segregar:

```java
public interface Workable  { void work(); }
public interface Feedable  { void eat(); }
public interface Sleepable { void sleep(); }

public class Robot implements Workable {
    public void work() { /* ... */ }
}
public class Human implements Workable, Feedable, Sleepable { /* ... */ }
```

Go lleva ISP a nivel cultural: interfaces son pequeñas e implícitas. `io.Reader` solo tiene `Read`. `io.Writer` solo tiene `Write`. `io.Closer` solo `Close`. Se combinan con `io.ReadWriter`, `io.ReadCloser`, etc.

```go
type Reader interface { Read(p []byte) (n int, err error) }
type Writer interface { Write(p []byte) (n int, err error) }
type Closer interface { Close() error }
type ReadWriter interface {
    Reader
    Writer
}
```

Regla mental: si un implementador tiene "partes que no aplican" (excepciones, no-op, TODO), segrega la interfaz.

### 3.4 Dependency Inversion: por qué la interfaz aunque no cambies de DB

DIP: **módulos de alto nivel no deben depender de módulos de bajo nivel. Ambos deben depender de abstracciones.**

Ejemplo típico: el módulo de dominio importa `PostgresOrderRepository` directamente. Viola DIP.

```java
// dominio/OrderProcessor.java
import infra.postgres.PostgresOrderRepository;   // <- direct dep a infra

public class OrderProcessor {
    private final PostgresOrderRepository repo = new PostgresOrderRepository();
    // ...
}
```

Fix — el dominio declara la interfaz, la infra la implementa:

```java
// dominio/OrderRepository.java (interfaz)
public interface OrderRepository {
    Optional<Order> findById(OrderId id);
    void save(Order order);
}

// dominio/OrderProcessor.java
public class OrderProcessor {
    private final OrderRepository repo;
    public OrderProcessor(OrderRepository repo) { this.repo = repo; }
}

// infra/postgres/PostgresOrderRepository.java
public class PostgresOrderRepository implements OrderRepository { /* ... */ }
```

La razón fuerte para preferir la interfaz **NO es "poder cambiar de Postgres a MongoDB"** — eso ocurre casi nunca. Es **testabilidad**: los tests de dominio pueden usar `InMemoryOrderRepository` de 20 líneas, corren en segundos y son deterministas. Sin la interfaz, cada test del dominio requiere `PostgresContainer`, red y transacciones — se vuelve test de integración, lento y frágil.

```java
// test/OrderProcessorTest.java
class InMemoryOrderRepository implements OrderRepository {
    private final Map<OrderId, Order> data = new HashMap<>();
    public Optional<Order> findById(OrderId id) { return Optional.ofNullable(data.get(id)); }
    public void save(Order o) { data.put(o.id(), o); }
}

@Test
void procesa_orden_paga() {
    var repo = new InMemoryOrderRepository();
    var proc = new OrderProcessor(repo);
    // ... test rápido y determinista
}
```

En arquitectura hexagonal / clean architecture, esta inversión es LA regla arquitectural: el dominio nunca importa infra; la infra implementa contratos declarados por el dominio.

---

## 4. Práctica avanzada (nivel senior)

### 4.1 Patrones creacionales: Factory Method vs Abstract Factory

- **Factory Method:** una jerarquía decide qué instancia concreta crear. Útil cuando solo varía UN tipo de producto.
- **Abstract Factory:** crea FAMILIAS de objetos relacionados que deben usarse juntos.

```typescript
// Abstract Factory: PDFRenderer + FontProvider + Encrypter deben ser
// todos de la variante dev, prod o cloud — no mezclarse.

interface PdfRenderer { render(html: string): Buffer; }
interface FontProvider { load(family: string): FontData; }
interface Encrypter { encrypt(data: Buffer, key: string): Buffer; }

interface DocumentFactory {
    createRenderer(): PdfRenderer;
    createFontProvider(): FontProvider;
    createEncrypter(): Encrypter;
}

class DevDocumentFactory implements DocumentFactory {
    createRenderer()     { return new HeadlessChromeRenderer(); }
    createFontProvider() { return new LocalFontProvider(); }
    createEncrypter()    { return new NoOpEncrypter(); }
}

class ProdDocumentFactory implements DocumentFactory {
    createRenderer()     { return new WkhtmltopdfRenderer(); }
    createFontProvider() { return new CdnFontProvider(); }
    createEncrypter()    { return new AesEncrypter(); }
}
```

En 2026, DI containers modernos (Spring `@Profile`, NestJS modules, .NET `IServiceCollection`) hacen Abstract Factory declarativo. Escribirlo explícito sigue siendo útil cuando la selección depende de runtime state (no config) o cuando hay validación de coherencia entre variantes.

### 4.2 Observer vs Pub/Sub: la diferencia es el acoplamiento

Aparentemente iguales, arquitecturalmente distintos:

- **Observer (GoF, 1994):** el subject conoce a sus observers directamente (lista de referencias). Acoplamiento in-process. Útil para UI (`button.onClick`, model-view en frameworks reactivos).
- **Pub/Sub:** publisher y subscriber no se conocen; un BROKER (event bus, Kafka, RabbitMQ, SNS) los desacopla. Cross-process, cross-machine, permite replay.

```javascript
// Observer clásico
class Subject {
    constructor() { this.observers = []; }
    subscribe(o) { this.observers.push(o); }
    notify(evt)  { this.observers.forEach(o => o.update(evt)); }
}

// Pub/Sub con broker (in-memory ejemplo)
class EventBus {
    constructor() { this.topics = new Map(); }
    subscribe(topic, handler) {
        if (!this.topics.has(topic)) this.topics.set(topic, []);
        this.topics.get(topic).push(handler);
    }
    publish(topic, evt) {
        (this.topics.get(topic) || []).forEach(h => h(evt));
    }
}
// Ningún publisher conoce a los subscribers.
```

Trade-off:

| | Observer | Pub/Sub |
|--|---------|---------|
| Infraestructura | Nada | Broker (Kafka, RabbitMQ) |
| Acoplamiento | Directo | Cero (via topic) |
| Cross-process | No | Sí |
| Replay/persistencia | No | Sí (Kafka log) |
| Latencia | Nanosegundos | ms (red) |
| Complejidad | Baja | Media/alta |

Netflix migró de Observer local a Kafka Pub/Sub para desacoplar microservicios — servicios pueden agregarse/quitarse sin coordinar deploys.

### 4.3 Decorator: composición ortogonal

Problema clásico: `HttpClient.send(req)` necesita añadir logging, retry, rate limiting, cache, auth. La solución naive genera un explosión combinatoria de subclases: `CachedRetryingLoggingHttpClient`.

Decorator: cada capacidad es un `HttpClient` que envuelve OTRO `HttpClient`.

```java
public interface HttpClient {
    HttpResponse send(HttpRequest req);
}

public class BaseHttpClient implements HttpClient {
    public HttpResponse send(HttpRequest req) { /* real HTTP call */ }
}

public class LoggingHttpClient implements HttpClient {
    private final HttpClient inner;
    public LoggingHttpClient(HttpClient inner) { this.inner = inner; }
    public HttpResponse send(HttpRequest req) {
        log.info("Request: {}", req);
        var res = inner.send(req);
        log.info("Response: {}", res.status());
        return res;
    }
}

public class RetryingHttpClient implements HttpClient {
    private final HttpClient inner;
    private final int maxAttempts;
    public RetryingHttpClient(HttpClient inner, int maxAttempts) {
        this.inner = inner; this.maxAttempts = maxAttempts;
    }
    public HttpResponse send(HttpRequest req) {
        Exception last = null;
        for (int i = 0; i < maxAttempts; i++) {
            try { return inner.send(req); }
            catch (Exception e) { last = e; }
        }
        throw new RuntimeException("All retries failed", last);
    }
}

public class CachingHttpClient implements HttpClient { /* similar */ }

// Composición en runtime:
HttpClient client =
    new CachingHttpClient(
        new RetryingHttpClient(
            new LoggingHttpClient(
                new BaseHttpClient()),
            3));
```

Ejemplos canónicos en el mundo real:
- Java IO: `BufferedInputStream(GZIPInputStream(FileInputStream(...)))`.
- Middleware chain en Express, Django, ASP.NET Core, Fastify.
- SLF4J: adapters + decorators sobre backends de logging.

Kotlin permite Decorator idiomático con delegation:

```kotlin
class LoggingHttpClient(private val inner: HttpClient) : HttpClient by inner {
    override fun send(req: HttpRequest): HttpResponse {
        println("REQ $req")
        return inner.send(req).also { println("RES $it") }
    }
}
```

### 4.4 Command: undo/redo y macros

Editor gráfico. Requisito: undo/redo ilimitado.

```typescript
interface Command {
    execute(): void;
    undo(): void;
}

class MoveCommand implements Command {
    constructor(
        private readonly obj: SceneObject,
        private readonly to: Point,
        private prev: Point = obj.position
    ) {}
    execute() { this.obj.position = this.to; }
    undo()    { this.obj.position = this.prev; }
}

class ChangeColorCommand implements Command {
    private prev!: Color;
    constructor(private obj: SceneObject, private to: Color) {}
    execute() { this.prev = this.obj.color; this.obj.color = this.to; }
    undo()    { this.obj.color = this.prev; }
}

class History {
    private undoStack: Command[] = [];
    private redoStack: Command[] = [];

    apply(cmd: Command) {
        cmd.execute();
        this.undoStack.push(cmd);
        this.redoStack = [];   // nueva acción invalida el redo
    }

    undo() {
        const cmd = this.undoStack.pop();
        if (!cmd) return;
        cmd.undo();
        this.redoStack.push(cmd);
    }

    redo() {
        const cmd = this.redoStack.pop();
        if (!cmd) return;
        cmd.execute();
        this.undoStack.push(cmd);
    }
}

// Macros = secuencia de comandos como un solo Command
class MacroCommand implements Command {
    constructor(private commands: Command[]) {}
    execute() { this.commands.forEach(c => c.execute()); }
    undo()    { [...this.commands].reverse().forEach(c => c.undo()); }
}
```

Aplicaciones canónicas: IDEs (IntelliJ, VS Code), Photoshop, Figma, Word, Excel. Redux es Command aplicado a UI state: cada action es un command, el reducer aplica, el time-travel debugger permite undo/redo.

Para acciones con side-effects externos (HTTP calls, DB writes que no son revertibles fácilmente), Command se combina con **compensating transactions** — la base del pattern **Saga** en microservicios.

### 4.5 Repository vs Active Record

Dos filosofías de acceso a datos:

- **Active Record (Fowler, PoEAA):** el modelo del dominio conoce cómo persistirse. `user.save()`. Rails, Django ORM (mixto).
- **Repository (Evans, DDD):** el dominio es puro; una capa Repository maneja persistencia. `userRepository.save(user)`. Spring Data JPA, .NET EF, Hibernate.

```ruby
# Active Record (Rails)
class User < ApplicationRecord
  validates :email, presence: true

  def send_welcome_email
    UserMailer.welcome(self).deliver_now
  end
end

user = User.new(name: "Ana", email: "ana@example.com")
user.save
```

```java
// Repository (Spring Data)
public interface UserRepository extends JpaRepository<User, Long> {
    Optional<User> findByEmail(String email);
}

// El modelo es POJO puro
public class User {
    private Long id;
    private String name;
    private String email;
    public boolean canPurchase(Item i) { /* lógica de dominio */ }
}

// El servicio orquesta
@Service
public class UserService {
    private final UserRepository users;
    private final EmailSender email;
    public User register(String name, String em) {
        var user = new User(null, name, em);
        users.save(user);
        email.sendWelcome(user);
        return user;
    }
}
```

Trade-offs:

| | Active Record | Repository |
|--|--------------|-----------|
| Velocidad inicial | Alta (Rails scaffolding) | Media (más setup) |
| Testabilidad del dominio | Requiere DB | POJO puro, in-memory |
| DDD / dominio rico | Difícil | Natural |
| Cambiar persistencia | Costoso | Sencillo (nueva impl) |
| Acoplamiento a framework | Alto | Bajo |

Rails eligió Active Record por productividad; startups iterando rápido lo prefieren. Netflix, Amazon, Google favorecen Repository por complejidad de dominio. Shopify (Rails) escaló a masivo sin migrar. La decisión no es puramente técnica — es sobre equipo, complejidad de dominio y velocidad requerida.

---

## 5. Ejemplo práctico completo: refactor de un módulo de descuentos

**Contexto.** Heredas un servicio `PricingService` que aplica descuentos según tipo de cliente, temporada, item y cupones. Ha crecido a 1200 líneas con 40+ ramas de `if`/`switch`. Legal, marketing y producto piden cambios cada sprint y cada release rompe algo.

**Paso 1 — Diagnóstico.**

```java
// Extracto del legacy
public BigDecimal calcularPrecio(Item item, Customer c, Coupon coupon, Season season) {
    BigDecimal price = item.basePrice;
    if (c.type == VIP)       price = price.multiply(new BigDecimal("0.80"));
    else if (c.type == GOLD) price = price.multiply(new BigDecimal("0.90"));
    if (season == BLACK_FRIDAY) price = price.multiply(new BigDecimal("0.70"));
    else if (season == SUMMER)  price = price.multiply(new BigDecimal("0.85"));
    if (coupon != null && coupon.code.equals("STUDENT10")) {
        price = price.subtract(price.multiply(new BigDecimal("0.10")));
    }
    if (item.category == FOOD && season == RAMADAN) price = price.multiply(new BigDecimal("0.75"));
    // ... 30+ ramas más
    return price;
}
```

Diagnóstico:
- **Viola SRP:** legal (impuestos), marketing (temporadas), producto (cupones), category managers cambian este método.
- **Viola OCP:** cada nuevo tipo de descuento modifica el método.
- **God method:** 1200 líneas, complejidad ciclomática >50.
- **Testing pesadilla:** cada combinación necesita un test propio.

**Paso 2 — Refactor a Chain of Discount Strategies.**

```java
public interface DiscountRule {
    boolean applies(PricingContext ctx);
    BigDecimal apply(BigDecimal current, PricingContext ctx);
}

public record PricingContext(
    Item item, Customer customer, Optional<Coupon> coupon, Season season) {}

public class VipCustomerDiscount implements DiscountRule {
    public boolean applies(PricingContext ctx) { return ctx.customer().type() == VIP; }
    public BigDecimal apply(BigDecimal p, PricingContext ctx) {
        return p.multiply(new BigDecimal("0.80"));
    }
}

public class BlackFridaySeasonDiscount implements DiscountRule {
    public boolean applies(PricingContext ctx) { return ctx.season() == BLACK_FRIDAY; }
    public BigDecimal apply(BigDecimal p, PricingContext ctx) {
        return p.multiply(new BigDecimal("0.70"));
    }
}

public class CouponDiscount implements DiscountRule {
    public boolean applies(PricingContext ctx) { return ctx.coupon().isPresent(); }
    public BigDecimal apply(BigDecimal p, PricingContext ctx) {
        var pct = ctx.coupon().get().percent();
        return p.subtract(p.multiply(pct));
    }
}

public class PricingService {
    private final List<DiscountRule> rules;
    public PricingService(List<DiscountRule> rules) { this.rules = rules; }

    public BigDecimal calculate(PricingContext ctx) {
        BigDecimal price = ctx.item().basePrice();
        for (var rule : rules) {
            if (rule.applies(ctx)) price = rule.apply(price, ctx);
        }
        return price;
    }
}
```

**Paso 3 — Wiring con Spring.**

```java
@Configuration
public class PricingConfig {
    @Bean
    public PricingService pricingService(List<DiscountRule> rules) {
        return new PricingService(rules);   // Spring inyecta todas las @Component DiscountRule
    }
}

@Component public class VipCustomerDiscount implements DiscountRule { /* ... */ }
@Component public class BlackFridaySeasonDiscount implements DiscountRule { /* ... */ }
// Añadir un descuento nuevo = crear una @Component. Cero modificación de PricingService.
```

**Paso 4 — Verificación con tests.**

```java
@Test
void vip_black_friday_stack_correctly() {
    var rules = List.of(
        new VipCustomerDiscount(),
        new BlackFridaySeasonDiscount());
    var svc = new PricingService(rules);
    var ctx = new PricingContext(
        new Item("prod-1", new BigDecimal("100")),
        new Customer(VIP), Optional.empty(), BLACK_FRIDAY);
    var precio = svc.calculate(ctx);
    // 100 * 0.80 * 0.70 = 56
    assertEquals(new BigDecimal("56.00"), precio);
}
```

**Discusión.**
- Cada `DiscountRule` es una unidad pequeña, testeable en aislamiento, con SRP claro.
- Añadir un descuento nuevo (por ejemplo un `RamadanFoodDiscount`) es una clase de 10 líneas. Cero riesgo de romper existentes.
- El orden importa: descuentos multiplicativos vs aditivos dan resultados distintos. En un sistema real esto se documentaría con `@Order(1)`, o se separaría en fases: primero multiplicativos, luego aditivos, luego cupones.
- Para reglas que cambian sin deploy, extraer a base de datos: `DiscountRule` genérico con `condition` y `formula` como expresiones evaluadas (Drools, Rules Engine).
- Trade-off: hemos convertido 40 ramas en 40 clases. Legítimo aquí porque las ramas son estables y cada una tiene lógica no trivial. Para 3-4 casos triviales, un `Map<Enum, Function>` o un simple `switch` habrían bastado.

---

## 6. Cheatsheet, reglas mentales y anti-patrones

**Reglas de oro:**

- ✅ SRP se mide por ACTORES que piden cambios, no por verbos superficiales.
- ✅ `record` / `data class` para value objects; entities ricas para dominio.
- ✅ Interfaces pequeñas y cohesivas (ISP). Segrega antes de crecer.
- ✅ DIP se justifica por testabilidad, no por "cambiar de DB".
- ✅ Patrones nacen del segundo o tercer uso. Refactor > adivinación.
- ✅ Composición > herencia por default.
- ✅ Tell, Don't Ask: pide al objeto que actúe, no le preguntes su estado.

**Anti-patrones nombrados:**

- ❌ **God Class / God Object** — clase de miles de líneas con múltiples responsabilidades.
- ❌ **Anemic Domain Model** — entities con solo getters/setters, lógica dispersa en services procedurales.
- ❌ **Singleton clásico** — estado global, tests frágiles, oculta dependencias.
- ❌ **Speculative Generality** — interfaces/abstracciones con una sola implementación "por si acaso".
- ❌ **Feature Envy** — un método usa más datos de OTRA clase que de la propia.
- ❌ **Shotgun Surgery** — una feature nueva requiere cambios en muchos lugares dispersos.
- ❌ **Train Wreck** — `a.getB().getC().getD().doIt()` (Law of Demeter).
- ❌ **Primitive Obsession** — modelar `Money`, `Email`, `UserId` como `String` en todos lados.

**Tabla de decisión: qué patrón (o ninguno):**

| Situación | Patrón |
|-----------|--------|
| Añadir capacidades ortogonales a un objeto | Decorator |
| Familia de algoritmos intercambiables | Strategy |
| Undo/redo o queue de acciones | Command |
| Adaptar interfaz vieja a interfaz nueva | Adapter |
| Simplificar acceso a subsistema complejo | Facade |
| Familias de objetos coherentes por entorno | Abstract Factory |
| Un algoritmo con pasos personalizables | Template Method |
| Eventos entre objetos in-process | Observer |
| Eventos entre servicios distribuidos | Pub/Sub (Kafka/SNS) |
| Colección conceptual de agregados | Repository |
| CRUD simple con lógica mínima | Active Record OK |
| Solo 2-3 casos simples | No patrón, un `if` |

---

## 7. Casos reales de la industria (2024-2026)

- **Basecamp "The Majestic Monolith" (DHH, 2016 y reediciones 2024).** Argumento vigente contra la sobre-abstracción y microservicios prematuros. Basecamp opera con un monolito Rails y ha ganado escalado y velocidad por evitar precisamente el pattern-worship y las abstracciones especulativas.
- **GitHub — Rails refactor a service objects (2019-2023).** GitHub migró parte de su Active Record maximalista a service objects + repositories cuando el dominio creció. El post-mortem interno documenta que la clave fue refactor incremental, no rewrite.
- **Netflix — Zuul 2 y Reactor (2018-2024).** Migración de arquitectura síncrona a reactiva basada en Observer/Reactive Streams. Explicado en detalle en Netflix Tech Blog. Trade-off medido: 25% mejor uso de CPU, coste ×3 en curva de aprendizaje del equipo.
- **Spring Framework — WebFlux out, Virtual Threads in (2025-2026).** En 2025, muchos equipos Spring empezaron a REMOVER WebFlux (paradigma reactivo puro) y volver a `RestController` bloqueante ejecutándose sobre virtual threads de Java 21. La razón: código secuencial simple con la performance del async. Es una lección directa sobre YAGNI y sobre-abstracción de patrones reactivos.
- **Discord — Elixir para presence, Rust para performance crítica (2020-2024).** Discord usa Elixir (actor model) para el servicio de presencia con millones de conexiones — un caso donde el patrón actor encaja perfectamente. Para servicios CPU-bound (compresión), migraron a Rust. Ejemplo de "elige el modelo según el problema" en lugar de dogma.
- **Air Canada chatbot (feb 2024).** El chatbot violó implícitamente Tell Don't Ask y encapsulamiento — expuso al usuario "estado interno" (una política inventada) sin validación. Coste: sentencia BCCRT obligando reembolso. Ejemplo de que la falta de encapsulamiento de comportamiento tiene consecuencias legales, no solo técnicas.

---

## 8. Ejercicios prácticos

### Ejercicio 1: Refactorizar un God Class

**Objetivo:** dado un `UserManager` de 800 líneas que hace auth, notifications, reports y permissions, aplicar Extract Class con tests de red.

**Setup:** repo con `UserManager.java` + suite de tests que cubre el comportamiento observable.

**Pasos:**
1. Corre los tests existentes. Deben pasar al 100% (red de seguridad).
2. Identifica 3-4 clusters de responsabilidad. Anota qué métodos van juntos.
3. Extrae `AuthService`, `NotificationService`, `ReportService`, `PermissionService` uno a la vez. Después de cada extract, ejecuta los tests.
4. `UserManager` queda como orquestador delgado o desaparece.

**Criterios de éxito:**
- [ ] Todos los tests originales siguen pasando tras cada refactor.
- [ ] Ninguna clase resultante supera 200 líneas.
- [ ] La complejidad ciclomática de cada método (medida con Radon o SonarQube) es <10.
- [ ] Puedes explicar qué actor solicita cambios sobre cada nueva clase.

**Bonus:** convierte 2 de las clases a interfaces + implementaciones para tests con doubles.

### Ejercicio 2: Detectar violación de LSP

**Objetivo:** dado un módulo con `Bird` (`fly()`) y `Penguin extends Bird`, escribir un test que detecte la violación y proponer un fix.

**Setup:** archivo con jerarquía Bird → Penguin → Sparrow → Eagle.

**Pasos:**
1. Escribe un test que instancie `Bird b = new Penguin()` y llame `b.fly()`. ¿Qué esperas?
2. Documenta cómo la implementación viola LSP (excepción, no-op, o comportamiento inesperado).
3. Refactor: `Bird` sin `fly()`; interfaz `FlyingBird extends Bird` con `fly()`. `Penguin` implementa solo `Bird`.
4. Ajusta código cliente que asumía `fly()` en `Bird`.

**Criterios de éxito:**
- [ ] Test rompe con la implementación original.
- [ ] Tras el fix, el compilador impide `new Penguin().fly()`.
- [ ] Zero excepciones runtime del tipo `UnsupportedOperationException`.
- [ ] Puedes explicar por qué la matemática ("un pingüino es un pájaro") no implica herencia de tipo.

### Ejercicio 3: Chain of Discount Rules

**Objetivo:** implementar el módulo de pricing del §5 con al menos 6 reglas distintas.

**Setup:** proyecto Java/Kotlin/TypeScript vacío.

**Pasos:**
1. Define `DiscountRule` con `applies()` y `apply()`.
2. Implementa: VIP, Gold, BlackFriday, Summer, StudentCoupon, RamadanFood.
3. Escribe `PricingService.calculate(ctx)` que aplica todas las rules que matcheen.
4. Escribe 10 tests que cubran combinaciones (VIP + BlackFriday, Gold + Coupon, sin descuento, etc.).
5. Añade UNA regla nueva sin modificar `PricingService`.

**Criterios de éxito:**
- [ ] `PricingService.calculate` cabe en <20 líneas.
- [ ] Cada `DiscountRule` es una clase independiente <30 líneas.
- [ ] Añadir la regla nueva requiere solo crear una clase.
- [ ] Los 10 tests pasan y cada uno es <10 líneas.

**Bonus:** añade `@Order` para controlar el orden de aplicación explícitamente.

### Ejercicio 4: Command Pattern con undo/redo

**Objetivo:** implementar un editor de texto minimalista con undo/redo ilimitado.

**Setup:** cualquier lenguaje. Recomendado TypeScript o Kotlin para tipado.

**Pasos:**
1. Define `Document` con `insert(pos, str)`, `delete(pos, len)`.
2. Define `Command` con `execute()` y `undo()`.
3. Implementa `InsertCommand`, `DeleteCommand`, `ReplaceCommand` (macro de delete + insert).
4. Implementa `History` con `apply(cmd)`, `undo()`, `redo()`.
5. Escribe tests que insertan, borran, undo 3 veces, redo 2 veces y verifican estado.

**Criterios de éxito:**
- [ ] Undo restaura EXACTAMENTE el estado previo.
- [ ] Redo tras undo restaura el estado tras la acción.
- [ ] Una acción nueva tras undo invalida el redo stack.
- [ ] MacroCommand (varias acciones agrupadas) se deshace atomicamente.

**Bonus:** implementa persistencia del history a disco para "reabrir sesión con undo".

### Ejercicio 5: Diagnosticar y romper Singleton

**Objetivo:** dado un `Config` implementado como Singleton clásico, migrarlo a DI para que los tests corran en paralelo.

**Setup:** proyecto Java o C# con `Config.getInstance()` estático + suite de tests que fallan intermitentemente cuando se ejecutan en paralelo.

**Pasos:**
1. Ejecuta los tests en paralelo (`mvn -T 4 test` o similar). Anota cuáles fallan.
2. Introduce interfaz `ConfigProvider`. `Config` la implementa.
3. Modifica clases que usaban `Config.getInstance()` para recibir `ConfigProvider` por constructor.
4. En tests, crea instancias frescas. En prod, un DI container (Spring, Dagger, Guice) provee una instancia.
5. Vuelve a ejecutar los tests en paralelo. Deben pasar al 100%.

**Criterios de éxito:**
- [ ] `Config.getInstance()` estático desaparece del código de negocio.
- [ ] Los tests corren en paralelo sin flakiness.
- [ ] Cada test puede definir su propia Config sin afectar a otros.
- [ ] Puedes explicar por qué Singleton clásico rompe testing en paralelo.

**Bonus:** documenta 2 casos donde Singleton SÍ es aceptable (ej. Logger cross-cutting con estado inmutable).

---

## 9. Recursos y siguientes pasos

**Referencias canónicas:**
- Gang of Four — *Design Patterns: Elements of Reusable Object-Oriented Software* (Gamma, Helm, Johnson, Vlissides, 1994). Todavía la biblia.
- Robert C. Martin — *Clean Architecture* (2017) y *Clean Code* (2008). SOLID moderno.
- Joshua Bloch — *Effective Java* (3rd ed., 2018). Items 15-25 sobre clases y herencia.
- Martin Fowler — *Refactoring* (2nd ed., 2018). Catálogo de refactorings y smells.
- Eric Evans — *Domain-Driven Design* (2003). Repository, entities, value objects, agregados.
- Vaughn Vernon — *Implementing Domain-Driven Design* (2013). DDD práctico con ejemplos.
- Barbara Liskov — *"Data Abstraction and Hierarchy"* (1987). El paper original de LSP.

**Blogs y herramientas 2026:**
- Refactoring.Guru — <https://refactoring.guru/> — patrones con diagramas y código en 8+ lenguajes.
- SourceMaking — <https://sourcemaking.com/> — patrones + anti-patrones + refactoring.
- SonarQube / SonarCloud — detección automatizada de smells y anti-patrones.
- ArchUnit (Java) / dependency-cruiser (JS) — enforce arquitectura en tests.
- Martin Fowler blog — <https://martinfowler.com/> — sigue publicando artículos vigentes.
- Uncle Bob blog — <https://blog.cleancoder.com/>.

**Qué leer/practicar después:** el siguiente capítulo cubre concurrencia y async — el terreno donde los principios de este capítulo se estresan bajo condiciones de race conditions y estado compartido. Antes de saltar, elige un módulo real (tuyo o open source) y aplica un refactor Extract Class con tests de red.

---

## 10. Preguntas de práctica (20)

- **Fuente:** [`packages/content/src/tech/programmer/sim-02-solid-and-patterns.json`](../../packages/content/src/tech/programmer/sim-02-solid-and-patterns.json)
- **Ruta en app:** `/programming/programmer/sim/programmer-sim-02-solid-and-patterns`

Cubre: encapsulamiento genuino, herencia vs composición, SRP por actor, cuándo NO usar un patrón (YAGNI), OCP con polimorfismo, LSP con Rectangle/Square, ISP con interfaces segregadas, DIP para testabilidad, Singleton como anti-patrón, Factory Method vs Abstract Factory, Observer vs Pub/Sub, Decorator vs herencia, Command + undo/redo, Repository vs Active Record, Strategy real vs sobre-ingeniería, Law of Demeter, Adapter vs Facade, God Object, CQRS y Anemic Domain Model.

---

## Navegación

← [Cap 01](./01-fundamentos-y-complejidad.md) · [Índice](./README.md) · [Cap 03 →](./03-concurrencia-y-async.md)

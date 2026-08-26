# Capítulo 13 — Ansible y configuration management

> **Focus:** Ansible como la herramienta agent-less de configuration management de facto en 2026. Cómo diseñar playbooks idempotentes, cuándo Ansible gana a Terraform y cuándo pierde frente a shell, cómo probar con Molecule y comparar con Chef/Puppet/Salt.
> **Áreas:** IaC · configuration management · automation
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Junior → Mid → Senior

## 0. Antes de empezar

**Pre-requisitos:**
- Linux básico (SSH keys, sudo, systemd, apt/dnf, systemctl).
- YAML: sabes que la indentación importa y por qué `- item` no es lo mismo que `item`.
- Fundamentos de IaC (ver [Cap 11 — IaC introducción](./12-fundamentos-terraform.md) y [Cap 12 — Fundamentos Terraform](./12-fundamentos-terraform.md)).
- Nociones de plantillas (Jinja2 no es obligatorio pero ayuda).
- Ideal: haber sufrido al menos una vez un script bash que "casi" configura un servidor y termina rompiéndolo.

**Glosario mínimo:**
- **Control node:** máquina donde corres `ansible-playbook`. Puede ser tu laptop, un runner CI/CD o AWX/AAP.
- **Managed node / target:** máquina que Ansible configura. Solo requiere SSH + Python (Linux) o WinRM/PowerShell (Windows).
- **Inventory:** lista de hosts a gestionar. Puede ser estática (INI/YAML) o dinámica (plugin de cloud).
- **Playbook:** archivo YAML con una lista de *plays*. Cada play apunta a un grupo de hosts y ejecuta *tasks* en orden.
- **Module:** unidad de trabajo idempotente (`apt`, `service`, `copy`, `template`, `user`). Los módulos son código Python que Ansible envía y ejecuta en el target.
- **Handler:** task que solo corre cuando otra la notifica (típicamente para restarts).
- **Role:** unidad reutilizable con estructura fija (`tasks/`, `handlers/`, `templates/`, `defaults/`, `vars/`, `meta/`).
- **Collection:** paquete distribuible que agrupa roles + modules + plugins. Se instala con `ansible-galaxy collection install`. Desde Ansible 2.10 (2020) es la unidad de distribución.
- **Idempotencia:** propiedad por la cual correr el playbook N veces produce el mismo estado final que correrlo 1 vez.
- **Ansible Vault:** cifrado simétrico (AES-256) para secretos embebidos en el repo.
- **Molecule:** framework oficial para testear roles en containers.
- **Ansible-core:** motor mínimo (paquete `ansible-core`). **Ansible community package** = `ansible-core` + colecciones curadas (paquete `ansible`).

**Setup mínimo:**

```bash
# 1. Instalar Ansible community package (11.x en 2024, 13.x aprox en 2026)
python3 -m pip install --user "ansible>=11"
ansible --version   # esperado: ansible [core 2.18+], python 3.11+

# 2. Instalar Molecule para tests
python3 -m pip install --user "molecule[docker]>=25" ansible-lint

# 3. Estructura mínima de un proyecto
mkdir -p ~/lab-ansible/{inventories/prod,roles,playbooks,group_vars,host_vars}
cd ~/lab-ansible

# 4. Inventory estático de prueba
cat > inventories/prod/hosts.ini <<'INI'
[webservers]
web1.example.com
web2.example.com

[dbservers]
db1.example.com

[production:children]
webservers
dbservers
INI

# 5. Ping ad-hoc para comprobar conectividad
ansible -i inventories/prod/hosts.ini webservers -m ping

# 6. Vault: crea un archivo cifrado
ansible-vault create group_vars/all/secrets.yml
```

**Nota versiones 2026:** Ansible community package publica una release major al año. `ansible 11` (nov 2024) requiere Python 3.11+ en el control node y `ansible-core 2.18`. La rueda avanza (13.x en 2026); las APIs de módulos oficiales son estables entre majors.

---

## 1. El gran cuadro

Ansible resuelve un problema muy concreto: **describir el estado deseado de un conjunto de servidores y aplicarlo de manera consistente, repetible y sin instalar agentes en cada máquina**. Antes de Ansible (creado por Michael DeHaan en 2012, adquirido por Red Hat en 2015 por 150 M USD), el mercado de configuration management estaba dominado por **Puppet** (2005) y **Chef** (2009), ambos basados en un modelo *agent + pull*: instalabas un daemon (`puppetd`, `chef-client`) en cada nodo, cada cierto tiempo el agent consultaba al server maestro y aplicaba la configuración. Eso funcionaba, pero traía consigo el coste de mantener y parchear el agent en flotas de miles de máquinas, más el mantenimiento del servidor central (PuppetDB, Chef Server).

Ansible cambió el paradigma con dos decisiones radicales: **agent-less** (solo requiere SSH + Python, ambos presentes por default en cualquier distro Linux moderna) y **push-based** (el control node envía instrucciones cuando tú se lo pides, no hay reconciliación continua). El coste operativo cayó drásticamente. Combinado con YAML como lenguaje (mucho más digerible que el DSL Ruby de Puppet/Chef para equipos ops-heavy), Ansible se convirtió en la puerta de entrada más fácil al mundo IaC/config management. En 2026 sigue siendo el estándar de facto para configuration management en Linux, con la única alternativa relevante siendo **SaltStack** (arquitectura ZeroMQ, más rápido en flotas gigantes pero con adopción menor).

Ansible se apoya en tres pilares conceptuales que hay que entender antes de escribir una línea: **inventario** (quiénes son mis hosts y cómo los agrupo), **playbooks** (qué hago con ellos, en qué orden, con qué variables) y **módulos idempotentes** (cómo garantizo que correr esto dos veces no rompe nada). Cuando alguno de los tres se descuida, aparecen los antipatrones clásicos: inventarios con IPs hardcoded que no sobreviven al primer autoscaling, playbooks monolíticos de mil líneas imposibles de mantener, y `shell:` en todas partes rompiendo la idempotencia.

Un punto crítico para 2026 es la distinción entre **`ansible-core`** (el motor: 25 módulos base, parsers, conectores) y **`ansible` community package** (motor + ~90 colecciones curadas: `amazon.aws`, `community.docker`, `kubernetes.core`, `ansible.posix`, etc.). Todo módulo no-core vive en una colección instalada con `ansible-galaxy collection install`. Este cambio arquitectónico (2020) permitió que `ansible-core` sea pequeño y estable y que las colecciones evolucionen a su propio ritmo, pero introdujo confusión: si copias un playbook antiguo con `- ec2:` (módulo v1) puede que no funcione y tengas que actualizar a `amazon.aws.ec2_instance`. Los FQCN (fully qualified collection names) son best practice hoy.

Finalmente, entender **dónde Ansible NO encaja** te ahorra tiempo: no es para provisionar infra desde cero (para eso Terraform u OpenTofu), no es para orquestar containers en runtime (para eso Kubernetes), no es un scheduler distribuido (para eso Nomad o Airflow). Ansible brilla configurando SO y aplicaciones en servidores existentes, orquestando despliegues multi-paso, aplicando parches masivos y automatizando runbooks. Usarlo fuera de esa zona es forzarlo y pagarlo caro.

---

## 2. Inventario, ad-hoc y playbooks (nivel básico)

### 2.1 Inventory estático y dinámico

Un inventario estático es un fichero (INI o YAML) commiteado en el repo. Los hosts se conocen y cambian poco. Es la opción sensata para infra on-prem estable o labs.

Ejemplo INI con grupos anidados y variables:

```ini
# inventories/prod/hosts.ini
[webservers]
web1.example.com http_port=80 max_clients=200
web2.example.com http_port=8080

[dbservers]
db1.example.com

[eu]
web1.example.com
db1.example.com

[us]
web2.example.com

[production:children]
webservers
dbservers

[production:vars]
env=production
ansible_user=deploy
```

Los `group_vars/` y `host_vars/` son directorios que Ansible carga automáticamente:

```yaml
# group_vars/webservers.yml
nginx_worker_processes: 4
nginx_worker_connections: 1024

# host_vars/web1.example.com.yml
ansible_host: 10.0.1.10   # override IP real
```

Un inventario dinámico usa un *plugin* que consulta una API cloud en runtime. Ejemplo `amazon.aws.aws_ec2`:

```yaml
# inventories/aws/aws_ec2.yml
plugin: amazon.aws.aws_ec2
regions:
  - eu-west-1
  - us-east-1
filters:
  instance-state-name: running
  tag:Environment: production
keyed_groups:
  - key: tags.Role
    prefix: role
  - key: placement.region
    prefix: aws_region
hostnames:
  - tag:Name
  - private-ip-address
compose:
  ansible_host: private_ip_address
```

Con eso `ansible-inventory -i inventories/aws/aws_ec2.yml --graph` devuelve grupos como `role_web`, `role_db`, `aws_region_eu_west_1` derivados automáticamente de las tags. En 2026 la convención es **combinar ambos**: pasa `-i inventories/` (directorio) y Ansible mergea todos los sources.

### 2.2 Comandos ad-hoc

Antes de escribir un playbook, Ansible se puede usar como una navaja suiza directa desde la línea:

```bash
# ping a todos
ansible -i inventories/prod all -m ping

# uptime en webservers
ansible webservers -a "uptime"

# instalar nginx en webservers (privilege escalation con -b)
ansible webservers -b -m ansible.builtin.apt \
  -a "name=nginx state=present update_cache=yes"

# copiar un archivo
ansible webservers -m ansible.builtin.copy \
  -a "src=./robots.txt dest=/var/www/html/robots.txt owner=www-data mode=0644"

# reiniciar un servicio en paralelo (30 hosts a la vez con -f 30)
ansible webservers -b -f 30 -m ansible.builtin.service \
  -a "name=nginx state=restarted"
```

Uso típico: verificación rápida, hotfixes controlados, comprobación de estado. No sustituye al playbook para nada persistente.

### 2.3 Estructura de un playbook

Un playbook es una lista de *plays*. Cada play apunta a un grupo, define `vars`, `tasks` y opcionalmente `handlers`.

```yaml
# playbooks/webserver.yml
---
- name: Configurar webservers con nginx + app estática
  hosts: webservers
  become: true
  gather_facts: true

  vars:
    nginx_pkg: nginx
    site_root: /var/www/linguadev
    site_conf: /etc/nginx/sites-available/linguadev.conf

  tasks:
    - name: Instalar nginx
      ansible.builtin.apt:
        name: "{{ nginx_pkg }}"
        state: present
        update_cache: true
        cache_valid_time: 3600

    - name: Crear directorio del sitio
      ansible.builtin.file:
        path: "{{ site_root }}"
        state: directory
        owner: www-data
        group: www-data
        mode: "0755"

    - name: Desplegar index.html desde template
      ansible.builtin.template:
        src: templates/index.html.j2
        dest: "{{ site_root }}/index.html"
        owner: www-data
        group: www-data
        mode: "0644"

    - name: Configuración de nginx del sitio
      ansible.builtin.template:
        src: templates/nginx-site.conf.j2
        dest: "{{ site_conf }}"
        owner: root
        group: root
        mode: "0644"
        validate: "nginx -t -c %s"
      notify: Reload nginx

    - name: Habilitar sitio (symlink en sites-enabled)
      ansible.builtin.file:
        src: "{{ site_conf }}"
        dest: /etc/nginx/sites-enabled/linguadev.conf
        state: link
      notify: Reload nginx

    - name: Asegurar que nginx está arrancado y habilitado en boot
      ansible.builtin.service:
        name: nginx
        state: started
        enabled: true

  handlers:
    - name: Reload nginx
      ansible.builtin.service:
        name: nginx
        state: reloaded
```

Observaciones clave:
- **FQCN** (`ansible.builtin.apt`) en lugar de `apt:` a secas.
- `become: true` = privilege escalation (por default `sudo`).
- `gather_facts: true` recolecta variables `ansible_*` del host (distro, IP, memoria, etc.).
- `validate:` corre `nginx -t` sobre el archivo temporal *antes* de moverlo a su sitio; si falla, la task falla y no rompe la config.
- `notify:` encola el handler; solo se ejecuta al final del play y solo si algún notify se disparó.

Ejecutar con `--check --diff` es el equivalente de `terraform plan`:

```bash
ansible-playbook -i inventories/prod playbooks/webserver.yml --check --diff
```

### 2.4 Idempotencia en la práctica

La primera vez que corres el playbook, la salida típica es:

```
PLAY RECAP *********************
web1.example.com : ok=6  changed=5  unreachable=0  failed=0
web2.example.com : ok=6  changed=5  unreachable=0  failed=0
```

La segunda vez:

```
PLAY RECAP *********************
web1.example.com : ok=6  changed=0  unreachable=0  failed=0
web2.example.com : ok=6  changed=0  unreachable=0  failed=0
```

`changed=0` en la segunda corrida es la señal de que has escrito playbooks idempotentes. Si aparece `changed=5` en cada rerun, algo no lo es —típicamente un `shell:` sin `creates:`/`removes:`, o un `command:` que no debería estar ahí. La regla dura: prefiere siempre un módulo dedicado antes que `shell:`. Si no queda otra opción, usa `creates:`/`removes:`/`changed_when:`:

```yaml
- name: Compilar app custom si no existe el binario
  ansible.builtin.shell: |
    cd /opt/miapp && make release
  args:
    creates: /opt/miapp/build/miapp   # si existe, task se marca ok, no changed
```

---

## 3. Handlers, tags, condicionales, loops (nivel medio)

### 3.1 Handlers y notify

Los handlers son tasks especiales que solo corren cuando otra task los notifica y solo **una vez** al final del play (aunque los notifiquen N tareas). Uso canónico: reiniciar un servicio si cambió su config.

```yaml
tasks:
  - name: Copiar config A
    ansible.builtin.copy: { src: a.conf, dest: /etc/app/a.conf }
    notify: Restart app

  - name: Copiar config B
    ansible.builtin.copy: { src: b.conf, dest: /etc/app/b.conf }
    notify: Restart app

handlers:
  - name: Restart app
    ansible.builtin.service: { name: app, state: restarted }
```

Aunque cambien A y B, `Restart app` se ejecuta una sola vez. Puedes forzar la ejecución inmediata con `meta: flush_handlers` (útil cuando necesitas que el restart ocurra antes de la siguiente task).

### 3.2 Tags para ejecución selectiva

Los tags permiten correr solo partes del playbook, muy útil en runbooks largos.

```yaml
- name: Configurar sistema
  hosts: all
  tasks:
    - name: Aplicar parches de seguridad
      ansible.builtin.apt: { upgrade: safe }
      tags: [patches, security]

    - name: Instalar monitoring agent
      ansible.builtin.apt: { name: node_exporter, state: present }
      tags: [monitoring]

    - name: Configurar firewall
      community.general.ufw: { rule: allow, port: 22 }
      tags: [firewall, security]
```

Ejecución selectiva:

```bash
# Solo parches
ansible-playbook site.yml --tags patches

# Solo monitoring
ansible-playbook site.yml --tags monitoring

# Todo excepto firewall
ansible-playbook site.yml --skip-tags firewall

# Listar tags disponibles
ansible-playbook site.yml --list-tags
```

Tags implícitos útiles: `always` (siempre se ejecuta), `never` (solo si lo pides explícitamente).

### 3.3 Condicionales con `when`

`when` recibe una expresión Jinja2 (sin `{{ }}`):

```yaml
- name: Instalar apache en RedHat family
  ansible.builtin.dnf:
    name: httpd
    state: present
  when: ansible_os_family == "RedHat"

- name: Instalar apache en Debian family
  ansible.builtin.apt:
    name: apache2
    state: present
  when: ansible_os_family == "Debian"

- name: Reiniciar solo en producción y solo si es viernes
  ansible.builtin.service:
    name: app
    state: restarted
  when:
    - env == "production"
    - ansible_date_time.weekday_number | int == 5
```

Buenas prácticas: usa listas cuando tienes varias condiciones (AND implícito, más legible que un `and` largo). Combina con `block/rescue/always` para manejo de errores:

```yaml
- name: Deploy con rollback automático
  block:
    - name: Actualizar binario
      ansible.builtin.copy:
        src: app-new
        dest: /opt/app/bin
        backup: true
    - name: Health check
      ansible.builtin.uri:
        url: http://localhost:8080/health
        status_code: 200
      retries: 10
      delay: 2
  rescue:
    - name: Rollback al binario anterior
      ansible.builtin.shell: |
        mv /opt/app/bin.*.bak /opt/app/bin
      args:
        removes: /opt/app/bin.*.bak
  always:
    - name: Notificar Slack
      ansible.builtin.uri:
        url: "{{ slack_webhook }}"
        method: POST
        body_format: json
        body: { text: "Deploy {{ ansible_hostname }}: {{ ansible_failed_task.name | default('OK') }}" }
```

### 3.4 Loops

Casi cualquier task acepta `loop`. Ejemplos comunes:

```yaml
- name: Crear varios usuarios
  ansible.builtin.user:
    name: "{{ item.name }}"
    groups: "{{ item.groups }}"
    shell: /bin/bash
    state: present
  loop:
    - { name: alice, groups: sudo }
    - { name: bob,   groups: developers }
    - { name: carol, groups: developers }
  loop_control:
    label: "{{ item.name }}"   # oculta el dict completo en el output

- name: Instalar varios paquetes en una sola pasada
  ansible.builtin.apt:
    name: "{{ packages }}"
    state: present
  vars:
    packages:
      - curl
      - htop
      - jq
      - vim

- name: Abrir puertos con until (reintenta hasta 5 veces)
  community.general.ufw:
    rule: allow
    port: "{{ item }}"
  loop: [22, 80, 443]
```

**Nota performance:** cuando puedas, pasa una lista al módulo (`apt: name=[...]`) en lugar de hacer loop de N tasks. La primera opción es una única llamada Python en el target; la segunda son N conexiones.

### 3.5 Facts, variables y precedencia

`gather_facts: true` popula el diccionario `ansible_facts` con datos del host (`ansible_facts.distribution`, `ansible_facts.memtotal_mb`, `ansible_facts.default_ipv4.address`...). Puedes desactivarlo (`gather_facts: false`) para ganar segundos si no los necesitas.

La precedencia de variables es una fuente famosa de dolor. De menor a mayor prioridad (simplificado):

1. `role defaults` (`roles/x/defaults/main.yml`).
2. `inventory group_vars`.
3. `inventory host_vars`.
4. `playbook group_vars` / `host_vars`.
5. Registered vars y facts.
6. `set_fact`.
7. `role vars` (`roles/x/vars/main.yml`).
8. `block vars` / `task vars`.
9. `extra vars` (`-e "foo=bar"` en CLI) — siempre gana.

Regla mental: **defaults son sugerencias; extra-vars son órdenes**. Documenta esto en el README de tu proyecto o algún compañero te va a odiar.

---

## 4. Roles, collections, Vault y Molecule (nivel avanzado)

### 4.1 Roles: estructura y reutilización

Un playbook de 500 líneas se vuelve ilegible. La solución canónica es empaquetar responsabilidades en *roles*. La estructura estándar (`ansible-galaxy role init nginx`):

```
roles/
  nginx/
    defaults/main.yml     # valores por defecto
    vars/main.yml         # variables no override-ables por env
    tasks/main.yml        # entry point de tasks
    handlers/main.yml     # handlers
    templates/            # archivos .j2
    files/                # archivos estáticos
    meta/main.yml         # dependencias entre roles
    README.md
    molecule/             # tests
```

Ejemplo mínimo:

```yaml
# roles/nginx/defaults/main.yml
nginx_worker_processes: auto
nginx_worker_connections: 1024
nginx_sites: []

# roles/nginx/tasks/main.yml
---
- name: Instalar nginx
  ansible.builtin.apt:
    name: nginx
    state: present
    update_cache: true

- name: Configurar nginx.conf principal
  ansible.builtin.template:
    src: nginx.conf.j2
    dest: /etc/nginx/nginx.conf
    validate: "nginx -t -c %s"
  notify: Reload nginx

- name: Desplegar sitios
  ansible.builtin.template:
    src: site.conf.j2
    dest: "/etc/nginx/sites-available/{{ item.name }}.conf"
  loop: "{{ nginx_sites }}"
  loop_control: { label: "{{ item.name }}" }
  notify: Reload nginx

- name: Habilitar sitios
  ansible.builtin.file:
    src: "/etc/nginx/sites-available/{{ item.name }}.conf"
    dest: "/etc/nginx/sites-enabled/{{ item.name }}.conf"
    state: link
  loop: "{{ nginx_sites }}"
  loop_control: { label: "{{ item.name }}" }
  notify: Reload nginx
```

Consumo desde un playbook:

```yaml
- hosts: webservers
  become: true
  roles:
    - role: nginx
      vars:
        nginx_worker_processes: 8
        nginx_sites:
          - name: linguadev
            server_name: app.linguadev.dev
            root: /var/www/linguadev
```

**Regla:** un rol hace **una** cosa (nginx, postgres, docker, monitoring). No metas `nginx + postgres + kafka` en el mismo rol.

### 4.2 Collections y Galaxy

Las collections son la unidad de distribución desde Ansible 2.10. Se instalan con `ansible-galaxy collection install` y se declaran en `requirements.yml`:

```yaml
# requirements.yml
collections:
  - name: amazon.aws
    version: ">=9.0.0"
  - name: community.docker
    version: ">=4.0.0"
  - name: kubernetes.core
    version: ">=5.0.0"
  - name: community.general
  - name: ansible.posix

roles:
  - name: geerlingguy.docker
    version: 7.4.2
  - src: git+https://github.com/tu-org/rol-privado.git
    version: main
    name: rol_privado
```

Instala en un directorio local del proyecto (mejor que globalmente):

```bash
ansible-galaxy install -r requirements.yml \
  --roles-path ./roles \
  --collections-path ./collections
```

Uso con FQCN:

```yaml
- name: Crear bucket S3
  amazon.aws.s3_bucket:
    name: linguadev-content-{{ env }}
    region: eu-west-1
    state: present
```

### 4.3 Ansible Vault

Los secretos NO viven en `vars/` en claro. Vault cifra archivos con AES-256:

```bash
# Crear archivo cifrado
ansible-vault create group_vars/all/secrets.yml

# Editar
ansible-vault edit group_vars/all/secrets.yml

# Cifrar un archivo existente
ansible-vault encrypt group_vars/prod/db.yml

# Ver contenido sin descifrar en disco
ansible-vault view group_vars/all/secrets.yml

# Rotar password
ansible-vault rekey group_vars/all/secrets.yml
```

Ejecución del playbook con vault (pide password interactivamente o via `--vault-password-file`):

```bash
ansible-playbook site.yml --ask-vault-pass
ansible-playbook site.yml --vault-password-file ~/.vault_pass.txt
```

**Multi-vault ID** permite dos passwords distintos por entorno:

```bash
ansible-vault encrypt --encrypt-vault-id prod group_vars/prod/secrets.yml
ansible-playbook site.yml \
  --vault-id prod@~/.vault_prod \
  --vault-id staging@~/.vault_staging
```

**Best practice:** cifra el archivo entero cuando puedas. Si necesitas mezclar claro y cifrado, usa `!vault` inline:

```yaml
# group_vars/all/mixed.yml
db_host: db.linguadev.internal   # en claro
db_password: !vault |
  $ANSIBLE_VAULT;1.1;AES256
  62313365396138613664383237323...
```

Alternativas en 2026: integración con **HashiCorp Vault** vía `community.hashi_vault.vault_kv2_get`, con **AWS Secrets Manager** vía `amazon.aws.secretsmanager_secret`, o con **1Password** vía `community.general.onepassword`. Vault (el módulo Ansible) sigue siendo válido para secretos que quieres versionar en el repo.

### 4.4 Molecule: testear roles como código

Molecule levanta containers (Docker por default, Podman, LXD, EC2, Vagrant), aplica el rol, y verifica el resultado. Skeleton:

```bash
cd roles/nginx
molecule init scenario --driver-name docker
```

Genera `roles/nginx/molecule/default/` con:

```yaml
# molecule.yml
---
driver:
  name: docker
platforms:
  - name: nginx-ubuntu-2404
    image: geerlingguy/docker-ubuntu2404-ansible
    pre_build_image: true
    command: /usr/sbin/init
    privileged: true
    volumes:
      - /sys/fs/cgroup:/sys/fs/cgroup:rw
provisioner:
  name: ansible
  inventory:
    host_vars:
      nginx-ubuntu-2404:
        nginx_sites:
          - { name: test, server_name: test.local, root: /var/www/test }
verifier:
  name: ansible
```

```yaml
# converge.yml (el playbook que aplica el rol)
---
- name: Converge
  hosts: all
  become: true
  roles:
    - role: nginx
```

```yaml
# verify.yml (tests idempotentes con ansible.builtin)
---
- name: Verify
  hosts: all
  become: true
  tasks:
    - name: nginx está corriendo
      ansible.builtin.service_facts:
    - assert:
        that: ansible_facts.services['nginx.service'].state == 'running'

    - name: puerto 80 escuchando
      ansible.builtin.wait_for:
        port: 80
        timeout: 5

    - name: sitio devuelve 200
      ansible.builtin.uri:
        url: http://localhost/
        status_code: 200
```

Ciclo:

```bash
molecule create      # crea containers
molecule converge    # aplica el rol
molecule idempotence # re-aplica y falla si changed>0
molecule verify      # corre verify.yml
molecule destroy     # limpia
molecule test        # todo el ciclo (create + converge + idempotence + verify + destroy)
```

Integra en CI (`.github/workflows/molecule.yml`):

```yaml
name: molecule
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        distro: [ubuntu2404, debian12, rockylinux9]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: '3.11' }
      - run: pip install "molecule[docker]" ansible-lint "ansible>=11"
      - run: cd roles/nginx && molecule test
        env:
          MOLECULE_DISTRO: ${{ matrix.distro }}
```

Complementa con `ansible-lint` (correr en cada PR): valida sintaxis, best practices y anti-patrones (uso de `shell:` sin `creates:`, tasks sin `name:`, uso de módulos deprecated).

### 4.5 Delegation, serial y strategies

`delegate_to` ejecuta una task en otro host mientras itera sobre el inventario original. Uso típico: actualizar un load balancer desde la task del host que se está actualizando.

```yaml
- name: Sacar host del LB antes de deployar
  community.general.haproxy:
    state: disabled
    backend: web
    host: "{{ inventory_hostname }}"
  delegate_to: haproxy.example.com

- name: Deploy nueva versión
  ansible.builtin.copy: { src: app.jar, dest: /opt/app.jar }
  notify: Restart app

- name: Meter host de vuelta al LB
  community.general.haproxy:
    state: enabled
    backend: web
    host: "{{ inventory_hostname }}"
  delegate_to: haproxy.example.com
```

`serial:` controla cuántos hosts se procesan en paralelo (rolling update):

```yaml
- hosts: webservers
  serial: "20%"   # 20% de la flota a la vez; puedes usar N absoluto
  max_fail_percentage: 25
  tasks: [...]
```

`strategy: free` deja que cada host avance a su ritmo (útil cuando algunos son mucho más lentos). Default es `linear` (todos esperan a que todos terminen la task actual antes de pasar a la siguiente).

---

## 5. Ejemplo práctico completo: baseline server para LinguaDev Pro

Aplicamos todo a un caso real: **baseline** que aplicaríamos a cualquier EC2 nueva antes de correr contenedores.

### Layout del proyecto

```
lab-ansible/
  ansible.cfg
  requirements.yml
  inventories/
    aws/
      aws_ec2.yml
      group_vars/
        all/secrets.yml           # vault-cifrado
        tag_Env_prod/main.yml
  playbooks/
    site.yml
    baseline.yml
  roles/
    baseline/
      defaults/main.yml
      tasks/main.yml
      handlers/main.yml
      templates/sshd_config.j2
      molecule/default/
```

### `ansible.cfg`

```ini
[defaults]
inventory = inventories/aws/aws_ec2.yml
roles_path = ./roles
collections_path = ./collections
host_key_checking = False
retry_files_enabled = False
callbacks_enabled = ansible.posix.profile_tasks
stdout_callback = yaml
forks = 30

[ssh_connection]
pipelining = True
control_path = /tmp/ansible-%%h-%%p-%%r
```

`pipelining = True` reduce ~50% las conexiones SSH por task. `profile_tasks` te muestra qué tasks tardan más.

### `roles/baseline/defaults/main.yml`

```yaml
baseline_timezone: Etc/UTC
baseline_ssh_port: 22
baseline_admin_users:
  - name: deploy
    key: "{{ lookup('file', 'files/deploy.pub') }}"
baseline_packages:
  - curl
  - htop
  - jq
  - unzip
  - fail2ban
  - unattended-upgrades
baseline_swap_size_mb: 2048
```

### `roles/baseline/tasks/main.yml`

```yaml
---
- name: Poner timezone
  community.general.timezone:
    name: "{{ baseline_timezone }}"

- name: Actualizar cache de apt (una vez por día)
  ansible.builtin.apt:
    update_cache: true
    cache_valid_time: 86400
  when: ansible_os_family == "Debian"

- name: Instalar paquetes base
  ansible.builtin.apt:
    name: "{{ baseline_packages }}"
    state: present

- name: Crear usuarios admin
  ansible.builtin.user:
    name: "{{ item.name }}"
    shell: /bin/bash
    groups: sudo
    append: true
    state: present
  loop: "{{ baseline_admin_users }}"
  loop_control: { label: "{{ item.name }}" }

- name: Desplegar authorized_keys
  ansible.posix.authorized_key:
    user: "{{ item.name }}"
    key: "{{ item.key }}"
    state: present
  loop: "{{ baseline_admin_users }}"
  loop_control: { label: "{{ item.name }}" }

- name: Sudo NOPASSWD para deploy
  ansible.builtin.copy:
    dest: /etc/sudoers.d/deploy
    content: "deploy ALL=(ALL) NOPASSWD:ALL\n"
    owner: root
    group: root
    mode: "0440"
    validate: "visudo -cf %s"

- name: Endurecer sshd
  ansible.builtin.template:
    src: sshd_config.j2
    dest: /etc/ssh/sshd_config
    owner: root
    group: root
    mode: "0644"
    validate: "sshd -t -f %s"
  notify: Restart sshd

- name: Crear swap si no existe
  block:
    - name: Ver si /swapfile ya existe
      ansible.builtin.stat: { path: /swapfile }
      register: swapfile

    - name: Crear /swapfile
      ansible.builtin.command: "fallocate -l {{ baseline_swap_size_mb }}M /swapfile"
      args: { creates: /swapfile }
      when: not swapfile.stat.exists

    - name: Permisos 0600 en /swapfile
      ansible.builtin.file: { path: /swapfile, owner: root, group: root, mode: "0600" }

    - name: mkswap
      ansible.builtin.command: "mkswap /swapfile"
      register: mkswap
      changed_when: "'Setting up swapspace' in mkswap.stdout"
      failed_when: mkswap.rc != 0 and 'already' not in mkswap.stderr

    - name: swapon
      ansible.posix.mount:
        src: /swapfile
        path: none
        fstype: swap
        opts: sw
        state: present

- name: Habilitar unattended-upgrades
  ansible.builtin.copy:
    dest: /etc/apt/apt.conf.d/20auto-upgrades
    content: |
      APT::Periodic::Update-Package-Lists "1";
      APT::Periodic::Unattended-Upgrade "1";
    owner: root
    group: root
    mode: "0644"
```

### `roles/baseline/handlers/main.yml`

```yaml
- name: Restart sshd
  ansible.builtin.service:
    name: ssh
    state: restarted
```

### `roles/baseline/templates/sshd_config.j2`

```jinja
# Managed by Ansible — do not edit
Port {{ baseline_ssh_port }}
Protocol 2
PermitRootLogin no
PasswordAuthentication no
ChallengeResponseAuthentication no
UsePAM yes
X11Forwarding no
AllowUsers deploy
MaxAuthTries 3
ClientAliveInterval 300
ClientAliveCountMax 2
```

### `playbooks/site.yml`

```yaml
---
- name: Baseline en producción
  hosts: tag_Env_prod
  become: true
  gather_facts: true
  roles:
    - baseline
```

### Ejecución

```bash
# 1. Instalar dependencias
ansible-galaxy install -r requirements.yml

# 2. Sanity check
ansible-inventory --graph

# 3. Dry-run
ansible-playbook playbooks/site.yml --check --diff --limit web1.example.com

# 4. Apply real, rolling 20% con vault
ansible-playbook playbooks/site.yml \
  --vault-password-file ~/.vault_pass.txt

# 5. Verificar idempotencia
ansible-playbook playbooks/site.yml --check | grep changed=
# esperado: changed=0 en todos los hosts
```

Este role compone la base sobre la que después aplicas roles de `docker`, `node_exporter`, `app_linguadev`, etc.

---

## 6. Cheatsheet + reglas mentales + antipatrones

### Reglas de oro

- ✅ FQCN (`ansible.builtin.apt`) siempre; nunca módulos sin colección.
- ✅ Idempotencia obligatoria: `changed=0` en la segunda corrida.
- ✅ `--check --diff` antes de aplicar en prod.
- ✅ Ansible **no** provisiona infra, la **configura**. Terraform crea; Ansible configura.
- ✅ Roles pequeños, una responsabilidad, testeados con Molecule.
- ✅ Secretos siempre en Vault o en un secret manager externo.
- ✅ `serial:` + `max_fail_percentage:` para rolling deploys.
- ✅ `validate:` cuando el archivo puede romper el servicio (nginx, sudo, sshd).
- ✅ `pipelining=True` en `ansible.cfg` (perf trivial).
- ✅ `ansible-lint` en CI, gate para merges.
- ✅ `handlers` para restarts, no restart-por-task.
- ✅ `block/rescue/always` para rollback automático.
- ✅ Inventario dinámico cuando la infra es elástica; estático cuando no.
- ✅ Precedencia de vars documentada en README del proyecto.
- ✅ Un playbook por flujo lógico, no un mega-monolito.

### Antipatrones

- ❌ `shell:` sin `creates:` / `changed_when:` (rompe idempotencia).
- ❌ `command: mv X Y` en lugar de `copy: force=no`.
- ❌ Secretos hardcoded en `group_vars/*.yml` en claro.
- ❌ Hardcodear IPs en el inventario para infra autoscale.
- ❌ `gather_facts: true` en todos los plays si no usas facts (pierdes segundos * hosts).
- ❌ `become_user: root` sin justificar (fuga de privilegios).
- ❌ Playbooks de 1000 líneas sin roles.
- ❌ Handlers con lógica compleja (deberían ser una única acción de restart/reload).
- ❌ Depender de `ansible_python_interpreter` implícito (declara siempre).
- ❌ Correr Ansible como *reconciliation loop* (Ansible es push, no pull; para reconciliación continua usa GitOps del cap 15).
- ❌ Usar Ansible para orquestar containers en runtime (usa Kubernetes).
- ❌ Copiar el mismo bloque de tasks 5 veces (usa loops o roles).
- ❌ Ignorar warnings de `ansible-lint`.
- ❌ Vault password en el repo.

### Tabla de decisión: Ansible vs alternativas

| Necesidad | Herramienta ideal | Por qué |
|---|---|---|
| Crear VPC, subnets, IAM en AWS | Terraform / OpenTofu | Diseñado para provisionar infra desde cero |
| Instalar y configurar nginx en 100 servers existentes | Ansible | Config management agent-less |
| Deployar app en Kubernetes | Helm + ArgoCD/Flux | K8s-native, ver Cap 15 |
| Hotfix urgente en 3 servers | Ansible ad-hoc (`ansible -m ...`) | Directo, sin escribir playbook |
| Configuración con reconciliación continua | Chef / Puppet / GitOps | Ansible es push, no pull |
| Automatizar tarea única en 1 servidor | Bash script | Ansible es overkill |
| Configurar 5000 servers on-prem | Ansible (con `serial:`) o SaltStack | Salt más rápido a escala extrema |

---

## 7. Casos reales industria 2020-2026

**Red Hat Ansible Automation Platform (AAP) 2.5 (2024-2026):** Red Hat consolida su oferta enterprise sobre AWX (upstream) con event-driven Ansible (EDA), automation mesh y RBAC. Empresas grandes migran de Puppet Enterprise a AAP por menor coste operativo. Lección: para flotas >500 nodos y compliance formal, AAP > `ansible-playbook` en un cron.

**GitHub migración de Chef → Ansible (2019-2020):** GitHub SRE documentó su migración de Chef a Ansible aprovechando la idempotencia de módulos oficiales y la menor curva para nuevos SRE. Punto crítico: reescribir cookbooks Chef en playbooks fue trabajo, pero mantener Ansible resultó 3-4x menos horas/año. Lección: la migración no es gratis, pero el TCO baja.

**NASA JPL Mars 2020 Rover ops (2020+):** JPL usa Ansible para gestionar la infraestructura de simulación y comando del rover Perseverance. Idempotencia crítica: reejecutar durante ventanas de comunicación no puede romper estado. Lección: idempotencia no es capricho.

**Wikimedia Foundation (2015-2026):** infra ~1000 hosts físicos gestionada con Puppet históricamente, pero muchos playbooks Ansible complementarios para tareas específicas. Modelo híbrido válido: no todo tiene que ser 100% Ansible.

**Ansible-core 2.15 minimum (Ansible 11, nov 2024):** rompió backwards-compat con playbooks antiguos que dependían de módulos sin FQCN. Muchos proyectos tuvieron que hacer `ansible-lint --fix` masivo. Lección: mantén tu Ansible actualizado; deuda técnica se paga.

**AWX 24.x y proyecto EDA:** Event-Driven Ansible (2023+, GA 2024) permite disparar playbooks en respuesta a eventos (webhooks, Kafka, Kinesis, alertas Prometheus). Uso típico: auto-remediation. Ejemplo: alert de disk >90% → playbook que limpia logs.

**Salt vs Ansible market shift (2022-2026):** SaltStack (adquirida por VMware 2020, luego Broadcom 2023) perdió tracción tras dudas sobre su futuro. Muchos equipos migraron a Ansible. Lección: acquisición vendor puede invalidar tu stack de config management.

**Ansible + Terraform combo (2020-2026):** patrón industry-wide: Terraform crea VPCs/EC2s/RDS; en el user-data del EC2 se dispara `cloud-init` que instala `ansible-pull` y aplica el playbook del repo. Alternativa: Terraform outputs → `terraform-inventory` → Ansible provision.

**HashiCorp Vault integration:** empresas con Vault ya desplegado usan `community.hashi_vault.vault_kv2_get` en lugar de Ansible Vault, para tener secretos centralizados con rotación, TTLs y audit log. Ansible Vault sigue siendo válido para secretos versionados en el repo.

---

## 8. Ejercicios prácticos

### Ejercicio 1: Playbook idempotente para nginx

**Objetivo:** escribir un playbook que instale nginx, deploye un `index.html`, arranque el servicio y sea 100% idempotente.

**Setup:** una VM Ubuntu 24.04 (Multipass, LXD, EC2, DigitalOcean droplet) con SSH accesible.

**Pasos:**
1. Crea `inventories/lab/hosts.ini` con la IP de tu VM.
2. Escribe `playbooks/nginx.yml` usando `ansible.builtin.apt`, `template`, `service`.
3. Añade un handler `Reload nginx`.
4. Corre `ansible-playbook -i inventories/lab playbooks/nginx.yml`.
5. Vuelve a correrlo y confirma `changed=0` en la segunda corrida.
6. Corre `ansible-playbook ... --check --diff` para ver dry-run.

**Criterios de éxito:**
- [ ] Primera corrida: `changed>=3` y nginx responde 200 en `http://<ip>/`.
- [ ] Segunda corrida: `changed=0`.
- [ ] `--check --diff` muestra "no changes" en la tercera.
- [ ] Uso de FQCN (`ansible.builtin.*`) en todas las tasks.
- [ ] Handler notify + reload (no restart-en-task).

**Bonus:** haz que el `server_name` venga de una variable y prueba pasarlo con `-e "server_name=example.com"`.

---

### Ejercicio 2: Convertir el playbook en un role + Molecule test

**Objetivo:** empaquetar el playbook del ejercicio 1 como role reutilizable con tests Molecule que pasen en CI.

**Setup:** Docker instalado localmente, `molecule[docker]` en el venv.

**Pasos:**
1. `ansible-galaxy role init roles/nginx`.
2. Mueve las tasks a `roles/nginx/tasks/main.yml`, template a `roles/nginx/templates/`, handler a `roles/nginx/handlers/`.
3. Convierte inputs en variables `defaults/main.yml`.
4. `cd roles/nginx && molecule init scenario --driver-name docker`.
5. Edita `molecule/default/molecule.yml` con `geerlingguy/docker-ubuntu2404-ansible`.
6. En `verify.yml` valida: servicio running, puerto 80 abierto, `curl` devuelve 200.
7. Corre `molecule test`.

**Criterios de éxito:**
- [ ] Role tiene estructura estándar (`defaults/`, `tasks/`, `handlers/`, `templates/`).
- [ ] `molecule converge` ejecuta sin errores.
- [ ] `molecule idempotence` pasa (segunda pasada sin cambios).
- [ ] `molecule verify` valida los 3 asserts.
- [ ] `molecule test` completo termina en verde.

**Bonus:** matriz con `ubuntu2404` + `debian12` + `rockylinux9` en `molecule.yml`.

---

### Ejercicio 3: Inventario dinámico AWS

**Objetivo:** apuntar Ansible a instancias EC2 reales sin hardcodear IPs.

**Setup:** cuenta AWS con al menos 2 EC2 running y taggeadas (`Env=lab`, `Role=web`).

**Pasos:**
1. Instala la collection `ansible-galaxy collection install amazon.aws`.
2. Crea `inventories/aws/aws_ec2.yml` con filtros por tag `Env=lab`.
3. Añade `keyed_groups` por `tags.Role`.
4. Configura credenciales AWS (`AWS_PROFILE` o IAM role del control node).
5. Corre `ansible-inventory -i inventories/aws --graph`.
6. Corre `ansible role_web -i inventories/aws -m ping`.

**Criterios de éxito:**
- [ ] `--graph` muestra grupos `role_web`, `aws_region_*` derivados de tags.
- [ ] `ansible role_web -m ping` responde `pong` en todas las instancias.
- [ ] No hay ninguna IP hardcoded en el repo.
- [ ] Al lanzar una nueva EC2 con `Env=lab`, aparece automáticamente en el inventario.

**Bonus:** combina el inventario dinámico con uno estático (bastion on-prem) en un directorio `inventories/mixed/` y confirma que Ansible los mergea.

---

### Ejercicio 4: Secretos con Vault + integración con Slack

**Objetivo:** cifrar un webhook de Slack con Vault y usarlo en un playbook para notificar cada deploy.

**Setup:** un webhook Slack (o cualquier URL que acepte POST, ej: webhook.site).

**Pasos:**
1. `ansible-vault create group_vars/all/secrets.yml`.
2. Añade `slack_webhook: https://hooks.slack.com/services/...`.
3. En tu playbook, en `always:` del bloque de deploy, añade una task `ansible.builtin.uri` que POST-ee el estado a `{{ slack_webhook }}`.
4. Corre el playbook con `--ask-vault-pass`.
5. Configura `--vault-password-file` para CI.
6. Confirma que el mensaje llega a Slack tanto en éxito como en fallo.

**Criterios de éxito:**
- [ ] `group_vars/all/secrets.yml` está cifrado (empieza por `$ANSIBLE_VAULT`).
- [ ] `git log -p group_vars/all/secrets.yml` no revela el webhook en texto plano.
- [ ] Notificación llega en el `always:` sea cual sea el resultado.
- [ ] Rerun del playbook no genera duplicados (idempotencia).

**Bonus:** añade dos vault-ids (`prod`, `staging`) con passwords distintas y demuestra que un playbook los usa transparentemente.

---

### Ejercicio 5 (bonus): rolling deploy con block/rescue

**Objetivo:** implementar un rolling update 20% con rollback automático si falla el health check.

**Setup:** 5+ hosts en un grupo `webservers` (pueden ser containers Docker o VMs).

**Pasos:**
1. Crea un playbook `rolling.yml` con `serial: "20%"` y `max_fail_percentage: 25`.
2. Estructura las tasks dentro de un `block` con `rescue` que copie el binario `.bak` de vuelta.
3. En el `block`, tras el deploy, haz un `uri:` a `/health` con `retries: 10 delay: 2`.
4. Simula un fallo introduciendo un binario corrupto y confirma que el rollback dispara.
5. Añade `delegate_to` para sacar cada host del load balancer antes del cambio y meterlo después.

**Criterios de éxito:**
- [ ] Deploy exitoso: recorre todos los hosts en batches de 20%.
- [ ] Deploy fallido: rescue restaura el binario anterior en el host afectado.
- [ ] `max_fail_percentage: 25` corta el deploy si >25% de hosts fallan.
- [ ] Load balancer refleja el estado real (host fuera durante el deploy).
- [ ] Log final claro (Slack o stdout) con hosts OK / hosts en rollback.

**Bonus:** añade métricas Prometheus (`node_exporter` + un `textfile_collector`) para trackear `deploy_success_total{env="prod"}`.

---

## 9. Recursos + siguientes pasos

**Documentación oficial:**
- [Ansible Community Documentation](https://docs.ansible.com/) — canónica.
- [Ansible 11 Porting Guide](https://docs.ansible.com/projects/ansible/latest/porting_guides/porting_guide_11.html).
- [Ansible Galaxy](https://galaxy.ansible.com/) — buscar collections y roles.
- [Molecule docs](https://ansible.readthedocs.io/projects/molecule/) — testing de roles.
- [ansible-lint](https://ansible.readthedocs.io/projects/lint/).

**Colecciones esenciales 2026:**
- `amazon.aws`, `azure.azcollection`, `google.cloud` — cloud providers.
- `community.docker`, `kubernetes.core`, `containers.podman` — containers.
- `community.general`, `ansible.posix` — utilidades comunes.
- `community.hashi_vault`, `community.crypto` — secretos y TLS.

**Libros y cursos:**
- Jeff Geerling — *Ansible for DevOps* (updated regularly).
- Jeff Geerling — *Ansible for Kubernetes* / *Ansible for AWS*.
- Michael DeHaan — talks en KubeCon y AnsibleFest.
- Sander van Vugt — *Red Hat Certified Engineer (RHCE) Ansible*.

**Alternativas y contextos:**
- **Puppet** — sigue vivo en enterprises con inversión histórica.
- **Chef / Cinc** — modelo similar; Cinc es el fork open-source.
- **SaltStack** — más rápido a escala, comunidad reducida tras Broadcom.
- **Nix / NixOS** — inmutabilidad total, curva empinada.
- **Bootstrap con cloud-init + Terraform** — para lo mínimo antes de que entre Ansible.

**Siguientes pasos:**
- Automatiza el baseline de LinguaDev Pro y guárdalo en el repo.
- Añade Molecule a cada role nuevo desde el día 1.
- Configura `ansible-lint` como pre-commit y en CI.
- Revisa [Cap 14 — cloud fundamentals y multi-cloud](./14-cloud-fundamentals-y-multi-cloud.md) para entender contra qué cloud vas a apuntar.
- Prepara la transición mental a [Cap 15 — GitOps con ArgoCD y Flux](./15-gitops-con-argocd-y-flux.md), donde el modelo push de Ansible da paso al modelo pull-reconciliation de GitOps.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales, distribuidas entre configuración de servidores, inventarios dinámicos, idempotencia, roles, Molecule, Vault, comparaciones vs Chef/Puppet/Salt y decisiones Ansible vs Terraform vs shell. Dificultades junior → mid → senior.

- **Fuente:** [`packages/content/src/tech/devops/sim-13-ansible-and-config-management.json`](../../packages/content/src/tech/devops/sim-13-ansible-and-config-management.json)
- **Ruta en app:** `/programming/devops/sim/devops-sim-13-ansible-and-config-management`
- **Tiempo:** 30 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 12 — Fundamentos Terraform](./12-fundamentos-terraform.md) · [Índice](./README.md) · [Capítulo 14 — Cloud fundamentals y multi-cloud →](./14-cloud-fundamentals-y-multi-cloud.md)

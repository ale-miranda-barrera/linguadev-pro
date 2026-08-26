# Capítulo 09 — Kubernetes Networking y Storage

> **Focus:** El data plane real del cluster. Cómo los Pods se comunican (CNI, Services, Ingress, Gateway API), cómo se resuelven nombres (CoreDNS), cómo se segmenta con NetworkPolicies y cómo se persiste estado (PV/PVC/StorageClass, CSI, StatefulSets con volumeClaimTemplates).
> **Áreas:** Kubernetes networking · Kubernetes storage · Multi-tenant security
> **Preguntas de práctica:** 20 · **Tiempo estimado:** 30 min · **Pass:** 75%
> **Nivel:** Básico → Medio → Avanzado

## 0. Antes de empezar

**Pre-requisitos:**
- Fundamentos de Kubernetes: Pod, Deployment, Namespace, kubectl (ver [cap 07 — kubernetes fundamentals](./07-fundamentos-kubernetes.md)).
- Workloads y ciclo de vida: ReplicaSet, StatefulSet, Job, probes (ver [cap 08 — kubernetes workloads](./08-kubernetes-workloads.md)).
- Networking clásico: TCP/UDP, DNS, subnets, NAT, iptables, CIDR notation, BGP básico.
- Storage básico: block vs file vs object, filesystems, snapshots.
- Docker containers y bind mounts (contexto).

**Glosario mínimo:**
- **CNI** (Container Network Interface): spec que define cómo se conectan Pods a la red. Implementaciones: Cilium, Calico, Flannel, AWS VPC CNI.
- **kube-proxy**: componente que traduce Service ClusterIP a Pods reales usando iptables, IPVS o eBPF.
- **Service**: recurso K8s que expone un conjunto de Pods bajo un DNS name estable. Tipos: `ClusterIP`, `NodePort`, `LoadBalancer`, `ExternalName`, `Headless`.
- **Ingress**: recurso L7 (HTTP/HTTPS) para exponer Services al exterior con reglas de host/path. Requiere Ingress Controller (Nginx, HAProxy, Traefik, cloud-managed).
- **Gateway API**: sucesor de Ingress. GA desde v1.0 (oct 2023), v1.2 (nov 2024), maduro en 2026. Roles separados (GatewayClass, Gateway, HTTPRoute, TCPRoute, GRPCRoute).
- **NetworkPolicy**: firewall L3/L4 declarativo por Pod. Requiere CNI que la implemente.
- **CoreDNS**: DNS server interno del cluster. Corre como Deployment en `kube-system`.
- **PV** (PersistentVolume): pieza de almacenamiento en el cluster.
- **PVC** (PersistentVolumeClaim): solicitud de storage por parte del usuario.
- **StorageClass**: define el "tipo" de storage (SSD, HDD, IOPS provisionados) y su provisioner.
- **CSI** (Container Storage Interface): spec estandarizada para drivers de storage (EBS CSI, EFS CSI, GCE PD, Ceph, Portworx).
- **StatefulSet**: workload con identidad estable por Pod (`pod-0`, `pod-1`), pensado para stateful apps (bases de datos, colas, quorums).
- **eBPF** (extended Berkeley Packet Filter): tecnología del kernel Linux que permite ejecutar bytecode custom sin recompilar. Base de Cilium, Isovalent, Tetragon.

**Setup mínimo:**

```bash
# 1. kubectl 1.32+ (agosto 2026)
kubectl version --client
# Client Version: v1.32.x

# 2. Cluster local con kind y CNI Calico (para probar NetworkPolicies)
cat > kind-calico.yaml <<'YAML'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking:
  disableDefaultCNI: true       # deshabilita kindnet
  podSubnet: "10.244.0.0/16"
nodes:
  - role: control-plane
  - role: worker
  - role: worker
YAML
kind create cluster --name lab --config kind-calico.yaml

# 3. Instalar Calico 3.28+
kubectl create -f https://raw.githubusercontent.com/projectcalico/calico/v3.28.2/manifests/tigera-operator.yaml
kubectl create -f https://raw.githubusercontent.com/projectcalico/calico/v3.28.2/manifests/custom-resources.yaml

# 4. Alternativa: Cilium 1.16+ con Gateway API habilitado
helm repo add cilium https://helm.cilium.io/
helm install cilium cilium/cilium --version 1.16.5 \
  --namespace kube-system \
  --set kubeProxyReplacement=true \
  --set gatewayAPI.enabled=true \
  --set hubble.enabled=true \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true

# 5. Utilidades: netshoot para debug de red
kubectl run debug --rm -it --image=nicolaka/netshoot -- bash

# 6. Storage local con csi-driver-host-path para pruebas
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/csi-driver-host-path/master/deploy/kubernetes-1.30/hostpath/csi-hostpath-driverinfo.yaml
```

---

## 1. El gran cuadro

Kubernetes no implementa red ni storage: define **contratos** y delega la implementación a plugins. Esta separación explica por qué el mismo manifiesto YAML se ejecuta en un `kind` local, en EKS con AWS VPC CNI y storage EBS, en GKE con Cilium Dataplane V2 y Persistent Disks, o en un cluster on-prem con Calico BGP y Ceph. El contrato de red es simple pero radical: **todo Pod tiene una IP única en el cluster y puede hablar con cualquier otro Pod sin NAT**. Nada de mapeos de puertos, nada de Docker bridge, nada de host-ports por default. Este modelo "flat" simplifica el diseño de aplicaciones porque el código no necesita saber si el peer está en el mismo nodo o en otro rack. Toda la complejidad se traslada al **CNI plugin**, que en 2026 se divide entre soluciones basadas en overlay (Flannel VXLAN), soluciones basadas en enrutamiento (Calico BGP) y soluciones basadas en eBPF (Cilium, adoptado por GKE Dataplane V2 y EKS opcional).

Encima de ese contrato de red plana viven las **abstracciones de descubrimiento**: `Service` (VIP estable con reglas de balanceo hacia un conjunto de Pods), `Endpoints`/`EndpointSlices` (la lista real de IPs de Pods detrás de un Service), `Ingress` (L7 HTTP/HTTPS con controlador externo) y la nueva **Gateway API** —GA desde octubre 2023 y considerada el sucesor legítimo de Ingress en 2026, con roles separados para operadores de infraestructura (`GatewayClass`, `Gateway`) y desarrolladores de aplicaciones (`HTTPRoute`, `TCPRoute`, `GRPCRoute`)—. Junto a esto, **CoreDNS** —proyecto CNCF Graduated— provee resolución interna (`payments-api.default.svc.cluster.local`), y **NetworkPolicy** convierte al cluster en un firewall declarativo por Pod. Cuando alguien dice "la red de Kubernetes es mágica", lo que en realidad describe es esta composición: el CNI le da IP a cada Pod, CoreDNS resuelve nombres, kube-proxy (o su reemplazo en eBPF) traduce Service IPs, e Ingress/Gateway API exponen todo al exterior.

El eje **storage** funciona con una filosofía análoga: el cluster no implementa filesystems ni block devices; en su lugar, un `PersistentVolumeClaim` (PVC) del usuario matchea contra un `PersistentVolume` (PV) —creado manualmente (static provisioning) o generado dinámicamente por una `StorageClass` que invoca un **CSI driver** (EBS CSI, EFS CSI, GCE PD, Ceph RBD, Portworx, Longhorn)—. La reforma más importante fue **CSI** (v1 en 2019, hoy standard universal): los drivers viven fuera del árbol de Kubernetes y se despliegan como CRDs + DaemonSets, lo que permite que AWS, Google, Azure, VMware y proveedores open-source iteren de forma independiente. Sobre CSI se construyen features de nivel superior: **volumeSnapshots** (backup declarativo), **volumeClaimTemplates** en `StatefulSet` (cada réplica obtiene su propio disco automáticamente), y **generic ephemeral volumes** para casos como CI/CD.

El impacto práctico en 2026 es concreto. Elegir el CNI equivocado te bloquea: Flannel no soporta NetworkPolicy, y migrar CNI a posteriori suele exigir rebuilds. Elegir el tipo de Service equivocado te sale caro: exponer 40 microservicios como `LoadBalancer` te da 40 ELBs a $18/mes cada uno; una única Gateway API con `HTTPRoute` por servicio ahorra $700/mes. Confundir `Service` con `Endpoints` en debug lleva a horas perdidas persiguiendo el fantasma equivocado. Y en storage, montar el mismo `PVC` `ReadWriteOnce` en dos Pods causa que el segundo se quede `Pending` indefinidamente. Este capítulo cubre los mecanismos, las trampas conocidas, y termina con ejercicios verificables sobre el proyecto **LinguaDev Pro** para practicar cada patrón.

---

## 2. El modelo de red y CoreDNS (nivel básico)

### 2.1 El contrato de red plana

El **network model** de Kubernetes exige cuatro propiedades:

1. Cada Pod recibe una IP única en el cluster (no compartida con el nodo).
2. Todo Pod puede hablar con todo Pod sin NAT por default.
3. Todo Nodo puede hablar con todo Pod sin NAT.
4. La IP que ve el Pod dentro de sí mismo es la misma que ven los demás.

Este contrato es implementado por el CNI plugin. Kubernetes por sí solo no configura interfaces, ni asigna IPs, ni instala rutas. El **kubelet**, al arrancar un Pod, invoca el binario CNI del nodo (por default `/opt/cni/bin/`) con los argumentos `ADD` (crear interface + IP) o `DEL` (limpiar). El plugin crea el network namespace del Pod, adjunta una interface (típicamente un `veth pair` con extremo en el nodo y otro dentro del Pod), asigna IP con su módulo IPAM (IP Address Management) y programa las rutas.

Verificar el CNI activo:

```bash
# Ver qué CNI está corriendo (usualmente DaemonSet)
kubectl -n kube-system get ds
# Ejemplo salida:
# NAME              DESIRED   READY   ...
# cilium            3         3
# node-local-dns    3         3

# Ver la configuración CNI en un nodo
kubectl debug node/lab-worker -it --image=busybox -- ls /host/etc/cni/net.d
# 10-calico.conflist  o  05-cilium.conflist

# Ver IP asignada a un Pod
kubectl run demo --image=nginx --restart=Never
kubectl get pod demo -o jsonpath='{.status.podIP}{"\n"}'
# 10.244.1.15
```

### 2.2 CoreDNS: la resolución interna

**CoreDNS** es el DNS server oficial desde Kubernetes 1.13. Corre como `Deployment` en `kube-system` (típicamente 2 réplicas con anti-affinity). El `Service` `kube-dns` (ClusterIP fijo, usualmente `10.96.0.10`) es el punto de entrada. El kubelet inyecta ese IP en `/etc/resolv.conf` de cada Pod:

```bash
kubectl exec demo -- cat /etc/resolv.conf
# search default.svc.cluster.local svc.cluster.local cluster.local
# nameserver 10.96.0.10
# options ndots:5
```

El FQDN completo de un Service es `<service>.<namespace>.svc.<cluster-domain>` (default `cluster.local`). Los `search domains` permiten nombres cortos:

```bash
# Desde un Pod en 'default', todos resuelven a lo mismo:
curl http://payments-api
curl http://payments-api.default
curl http://payments-api.default.svc
curl http://payments-api.default.svc.cluster.local
```

**Trampa clásica: `ndots:5`.** Cualquier hostname con menos de 5 puntos hace que el resolver pruebe primero los `search domains`. `api.stripe.com` (2 puntos) genera 4 queries fallidas antes de la buena. En apps con miles de conexiones/segundo, esto satura CoreDNS. Fixes:

- Usar FQDN con punto final: `api.stripe.com.` (el punto final le dice al resolver "no busques search").
- Ajustar `dnsConfig` del Pod: `options: [{ name: "ndots", value: "1" }]`.
- Desplegar **NodeLocal DNS Cache** (`nodelocaldns`) como DaemonSet: cache por nodo que reduce load a CoreDNS y latencia.

Configuración de CoreDNS (Corefile):

```yaml
# kubectl -n kube-system edit configmap coredns
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns
  namespace: kube-system
data:
  Corefile: |
    .:53 {
        errors
        health { lameduck 5s }
        ready
        kubernetes cluster.local in-addr.arpa ip6.arpa {
          pods insecure
          fallthrough in-addr.arpa ip6.arpa
        }
        prometheus :9153
        forward . /etc/resolv.conf {
          max_concurrent 1000
        }
        cache 30
        loop
        reload
        loadbalance
    }
    # Zona custom: forward *.internal.corp a un DNS interno
    internal.corp:53 {
        errors
        cache 30
        forward . 10.0.0.53
    }
```

### 2.3 Services: ClusterIP, NodePort, LoadBalancer, Headless

Cuatro tipos "oficiales" + un modo especial:

- **ClusterIP** (default): VIP virtual solo alcanzable dentro del cluster. Es la unidad básica; el resto de tipos son extensiones.
- **NodePort**: además del ClusterIP, expone un puerto en **todos los nodos** (rango default `30000-32767`). Útil para testing o balanceadores externos que apuntan al nodo.
- **LoadBalancer**: además de NodePort + ClusterIP, pide al cloud provider un LB externo (AWS ELB/NLB, GCP Load Balancer, Azure LB). Cada LB cuesta dinero.
- **ExternalName**: no crea proxy; solo devuelve un `CNAME` DNS. Útil para "aliasear" recursos externos.
- **Headless** (`clusterIP: None`): sin VIP, DNS retorna directamente las IPs de los Pods. Base de `StatefulSet` (`db-0.mydb`, `db-1.mydb`).

Manifest típico:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: payments-api
  namespace: prod
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: payments-api
  ports:
    - name: http
      port: 80          # puerto del Service
      targetPort: 8080  # puerto del contenedor
      protocol: TCP
---
apiVersion: v1
kind: Service
metadata:
  name: postgres-headless
  namespace: prod
spec:
  clusterIP: None       # headless
  selector:
    app: postgres
  ports:
    - port: 5432
```

### 2.4 Services, Endpoints y EndpointSlices

Un `Service` con `selector` genera automáticamente un objeto `Endpoints` (o `EndpointSlice` en clusters grandes) con las IPs+puertos reales de los Pods matchados. El `endpoints-controller` mantiene la lista sincronizada con los Pods `Ready`.

```bash
kubectl get svc payments-api -o wide
# NAME          CLUSTER-IP    PORT(S)   SELECTOR
# payments-api  10.96.5.10    80/TCP    app.kubernetes.io/name=payments-api

kubectl get endpointslices -l kubernetes.io/service-name=payments-api
# NAME                 ADDRESSTYPE   PORTS   ENDPOINTS
# payments-api-abc12   IPv4          8080    10.244.1.15,10.244.2.7,10.244.1.22
```

**EndpointSlices** (v1 desde K8s 1.21) reemplazan a `Endpoints` para escalabilidad: en lugar de un solo objeto con miles de IPs, se agrupan en slices de 100 endpoints por default. Consecuencia: menos churn en etcd cuando un Pod cambia, menos tráfico watch, mejor performance en clusters grandes.

**Debug clásico "mi Service no responde":**

```bash
# 1. ¿El selector encuentra Pods?
kubectl get pods -l app.kubernetes.io/name=payments-api
# 2. ¿Los Pods están Ready?
kubectl get pods -l app.kubernetes.io/name=payments-api -o wide
# 3. ¿Endpoints tienen las IPs?
kubectl get endpointslices -l kubernetes.io/service-name=payments-api
# 4. ¿El puerto del contenedor coincide con targetPort?
kubectl get svc payments-api -o yaml | grep targetPort
# 5. Test intra-cluster
kubectl run curl --rm -it --image=curlimages/curl -- \
  curl -v http://payments-api.default.svc.cluster.local
```

Si `Endpoints` está vacío, el problema es el `selector` o el `readinessProbe`. Si tiene IPs pero no responde, el problema es el `targetPort` o firewall del container.

---

## 3. Ingress, Gateway API y CNIs modernos (nivel medio)

### 3.1 Ingress: el clásico L7

`Ingress` es un recurso L7 (HTTP/HTTPS) que expone Services externos con reglas de `host` y `path`. **Requiere un Ingress Controller**: Nginx (ingress-nginx), HAProxy, Traefik, AWS ALB Controller, GCP GLBC. Sin controller, el objeto `Ingress` no hace nada.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: linguadev-ingress
  namespace: prod
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: nginx
  tls:
    - hosts: [linguadev.app, api.linguadev.app]
      secretName: linguadev-tls
  rules:
    - host: linguadev.app
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web-frontend
                port:
                  number: 80
    - host: api.linguadev.app
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: api-backend
                port:
                  number: 80
```

Limitaciones de Ingress que la Gateway API resuelve:

- Un solo tipo (`Ingress`) mezcla responsabilidades de infra y app.
- Extensiones vía **annotations** específicas de cada controller (portable? no).
- Solo HTTP/HTTPS oficialmente; TCP/UDP requieren annotations no-standard.
- No hay separación de rol entre "operador que provisiona el LB" y "dev que enruta paths".

### 3.2 Gateway API: el sucesor

**Gateway API** llegó a GA (v1.0) en octubre 2023, alcanzó v1.2 en noviembre 2024, y en 2026 es considerada el reemplazo standard de Ingress. Divide responsabilidades en tres roles:

- **Infrastructure provider** define `GatewayClass` (implementación: Cilium, Istio, Envoy Gateway, Kong, HAProxy).
- **Cluster operator** crea `Gateway` (instancia real con listeners, TLS, IPs).
- **Application developer** crea `HTTPRoute` / `TCPRoute` / `GRPCRoute` para enrutar tráfico a Services.

Manifest completo:

```yaml
# Infra: cómo se implementan los Gateways
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: cilium
spec:
  controllerName: io.cilium/gateway-controller
---
# Operador: instancia con listeners y TLS
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: prod-gateway
  namespace: gateway-system
spec:
  gatewayClassName: cilium
  listeners:
    - name: https
      port: 443
      protocol: HTTPS
      tls:
        mode: Terminate
        certificateRefs:
          - name: linguadev-tls
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              gateway-access: "true"
---
# Dev: reglas de routing
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-route
  namespace: prod
  labels:
    gateway-access: "true"
spec:
  parentRefs:
    - name: prod-gateway
      namespace: gateway-system
  hostnames: ["api.linguadev.app"]
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /v1
      backendRefs:
        - name: api-backend-v1
          port: 80
          weight: 90            # canary 90/10 nativo
        - name: api-backend-v2
          port: 80
          weight: 10
    - matches:
        - path:
            type: PathPrefix
            value: /admin
        - headers:
            - name: X-Internal
              value: "true"
      backendRefs:
        - name: admin-backend
          port: 80
```

Ventajas concretas sobre Ingress:

- Canary/weighted routing **nativo** (sin annotations).
- Header/method matching sin depender de vendor-specific extensions.
- TCP/UDP/GRPC como first-class citizens.
- Multi-tenant: `allowedRoutes.namespaces` controla qué namespaces pueden adjuntar `HTTPRoute` a un Gateway.
- **GAMMA** (Gateway API for Mesh Management) desde v1.1 unifica ingress y service mesh.

En 2026, Cilium 1.16+, Istio 1.24+, Envoy Gateway 1.2+ y Kong 3.x soportan Gateway API en producción. Google GKE Dataplane V2 usa Cilium con Gateway API integrado.

### 3.3 CNI plugins: Cilium 1.16+, Calico 3.28+, Flannel

**Landscape 2026:**

| Plugin | Fuerza | Modo típico | NetworkPolicy | Observability |
|---|---|---|---|---|
| **Cilium 1.16+** | eBPF, más avanzado | Native routing + eBPF | L3/L4 + L7 + FQDN | Hubble (flow visibility) |
| **Calico 3.28+** | Production standard, robusto | BGP nativo, VXLAN, IPIP | L3/L4 + L7 (con Envoy) | Calico Enterprise |
| **Flannel** | El más simple | VXLAN overlay | ❌ (usar Calico for policy) | Mínima |
| **AWS VPC CNI** | Integración AWS SG | Pods obtienen IP de VPC | Sí (Security Groups) | VPC Flow Logs |
| **Antrea** | VMware-native, OVS | Geneve overlay | Sí + FQDN | Traceflow |

**Cilium con eBPF** reemplaza `kube-proxy` completamente (`kubeProxyReplacement=true`), elimina iptables (que degrada linealmente con número de Services) y añade **L7 policies** de tipo:

```yaml
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-payments-get-only
  namespace: prod
spec:
  endpointSelector:
    matchLabels:
      app: payments-api
  ingress:
    - fromEndpoints:
        - matchLabels:
            app: web-frontend
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              - method: GET
                path: /api/v1/orders/.*
              - method: POST
                path: /api/v1/orders$
```

**Hubble** (parte de Cilium) provee visibilidad L3-L7:

```bash
# Ver flujos en tiempo real
hubble observe --namespace prod --follow
# Ver drops por policy
hubble observe --verdict DROPPED --last 100
# UI web
kubectl -n kube-system port-forward svc/hubble-ui 12000:80
```

### 3.4 NetworkPolicy: firewall declarativo

Semántica no-trivial: **sin NetworkPolicy = todo permitido**. Cuando **una** NetworkPolicy selecciona un Pod, ese Pod pasa a **deny-by-default** excepto por lo que la policy permite. Regla mental: "el conjunto de todas las policies aplicables a un Pod se UNEN (OR); si al menos una permite, se permite".

Baseline "default deny all" para un namespace:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: prod
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
# sin ingress/egress rules → todo bloqueado
```

Después, allows específicos:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: web-to-api
  namespace: prod
spec:
  podSelector:
    matchLabels: { app: api-backend }
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector:
            matchLabels: { app: web-frontend }
      ports:
        - port: 8080
          protocol: TCP
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns-and-db-egress
  namespace: prod
spec:
  podSelector:
    matchLabels: { app: api-backend }
  policyTypes: [Egress]
  egress:
    - to:
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: kube-system }
          podSelector:
            matchLabels: { k8s-app: kube-dns }
      ports:
        - port: 53
          protocol: UDP
    - to:
        - podSelector:
            matchLabels: { app: postgres }
      ports:
        - port: 5432
          protocol: TCP
```

**Trampa crítica: olvidar egress DNS.** Un `default-deny-all` que no permite egress a `kube-dns:53` deja a los Pods incapaces de resolver nada, y todos los errores parecen "conexión rechazada" cuando en realidad es DNS. Fix: siempre añadir explícitamente egress a `kube-system/kube-dns:53/UDP`.

---

## 4. Storage: PV, PVC, StorageClass, CSI (nivel avanzado)

### 4.1 El triángulo PV/PVC/StorageClass

- **PersistentVolume (PV)**: recurso cluster-wide que representa un trozo de storage real (un disco EBS, un share NFS, un RBD volume).
- **PersistentVolumeClaim (PVC)**: request de un usuario dentro de un namespace ("dame 20Gi, RWO, storageClass `gp3`").
- **StorageClass**: definición del "tipo" de storage (provisioner, params) para provisionamiento dinámico.

Flujo dinámico (99% de los casos en 2026):

```yaml
# StorageClass: define cómo se crean los volúmenes
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3-fast
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  iops: "6000"
  throughput: "500"
  encrypted: "true"
  kmsKeyId: alias/eks-storage
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete
allowVolumeExpansion: true
---
# PVC: el usuario pide
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-data
  namespace: prod
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: gp3-fast
  resources:
    requests:
      storage: 100Gi
```

Al crear el PVC, el `csi-provisioner` (parte del EBS CSI driver) llama a la API de AWS, crea el volume EBS, y devuelve un PV que matchea el claim. El binding queda 1:1 (una PVC bindea a un solo PV, y viceversa).

**`volumeBindingMode: WaitForFirstConsumer`** es crítico en clusters multi-AZ: retrasa la creación del disco hasta que el scheduler decida en qué nodo (y AZ) va el Pod, evitando que se cree un EBS en us-east-1a cuando el Pod acaba en us-east-1c (EBS no cruza AZ).

**Access modes:**

| Modo | Significado | Ejemplos |
|---|---|---|
| `ReadWriteOnce` (RWO) | Un solo nodo puede montar RW | EBS, GCE PD |
| `ReadOnlyMany` (ROX) | Varios nodos leen | Configs compartidos |
| `ReadWriteMany` (RWX) | Varios nodos escriben | EFS, NFS, CephFS |
| `ReadWriteOncePod` (RWOP) | Un solo Pod (no solo nodo) | Since 1.29 GA, más estricto |

### 4.2 CSI drivers: la revolución

**CSI (Container Storage Interface)** desacopla drivers de storage del árbol de Kubernetes. Antes de CSI, cada driver (EBS, GCE PD, Azure Disk) vivía en el código de K8s ("in-tree") y cualquier bug requería un release del propio K8s. Con CSI, los drivers son:

- **Controller plugin**: Deployment que habla con la API del provider (crea/borra volúmenes).
- **Node plugin**: DaemonSet en cada nodo que hace mount/unmount.
- **Sidecars estándar**: `csi-provisioner`, `csi-attacher`, `csi-resizer`, `csi-snapshotter`.

Drivers populares en 2026:

- **aws-ebs-csi-driver** (block, RWO).
- **aws-efs-csi-driver** (NFS, RWX).
- **aws-mountpoint-s3-csi-driver** (S3 como filesystem, GA 2024, útil para ML datasets).
- **gcp-pd-csi-driver**, **azuredisk-csi-driver**, **azurefile-csi-driver**.
- **ceph-csi** (RBD + CephFS).
- **longhorn** (block distribuido open-source).
- **openebs** (mayadata, block y filesystem).
- **portworx** (block enterprise).

Ver drivers instalados:

```bash
kubectl get csidrivers
# NAME                    ATTACH REQUIRED   POD INFO ON MOUNT
# ebs.csi.aws.com         true              false
# efs.csi.aws.com         false             false

kubectl get storageclasses
# NAME              PROVISIONER          VOLUMEBINDINGMODE
# gp3-fast          ebs.csi.aws.com      WaitForFirstConsumer
# efs-shared        efs.csi.aws.com      Immediate
```

### 4.3 StatefulSet + volumeClaimTemplates

Cuando desplegás Postgres, Kafka, ElasticSearch o cualquier stateful app, **cada réplica necesita su propio disco**. Repetir `PVC` manualmente para cada réplica es un anti-patrón. La solución: `volumeClaimTemplates` dentro del `StatefulSet`.

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: prod
spec:
  serviceName: postgres-headless
  replicas: 3
  selector:
    matchLabels: { app: postgres }
  template:
    metadata:
      labels: { app: postgres }
    spec:
      containers:
        - name: postgres
          image: postgres:17.2-alpine
          ports:
            - containerPort: 5432
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
          env:
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef: { name: pg-secret, key: password }
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ReadWriteOnce]
        storageClassName: gp3-fast
        resources:
          requests:
            storage: 100Gi
```

Resultado: cada réplica (`postgres-0`, `postgres-1`, `postgres-2`) obtiene su propio PVC (`data-postgres-0`, `data-postgres-1`, `data-postgres-2`), su propio EBS de 100Gi, y su propio DNS estable (`postgres-0.postgres-headless.prod.svc.cluster.local`) gracias al headless Service.

**Advertencia:** al escalar down un StatefulSet, los PVCs **no se eliminan** por default (protección). Si querés que se borren, desde K8s 1.27 (GA en 1.29+) hay `.spec.persistentVolumeClaimRetentionPolicy`:

```yaml
spec:
  persistentVolumeClaimRetentionPolicy:
    whenDeleted: Retain   # o Delete
    whenScaled: Delete    # borra PVCs al scale down
```

### 4.4 Volume Snapshots y clones

CSI snapshots (GA en K8s 1.20+, madurez plena en 2026):

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: gp3-snap
driver: ebs.csi.aws.com
deletionPolicy: Retain
---
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: postgres-backup-20260813
  namespace: prod
spec:
  volumeSnapshotClassName: gp3-snap
  source:
    persistentVolumeClaimName: data-postgres-0
---
# Restaurar creando un PVC desde el snapshot
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-restored
  namespace: prod
spec:
  storageClassName: gp3-fast
  dataSource:
    name: postgres-backup-20260813
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 100Gi
```

Herramientas de nivel superior: **Velero** para backup de cluster + PVCs, **Kasten K10** enterprise.

### 4.5 Expansion online

`allowVolumeExpansion: true` en la StorageClass + editar el PVC (`storage: 200Gi`) desencadena resize online sin restart del Pod (si el driver soporta filesystem expansion, como EBS gp3 + ext4/xfs). Verificar:

```bash
kubectl patch pvc data-postgres-0 -n prod \
  --type merge -p '{"spec":{"resources":{"requests":{"storage":"200Gi"}}}}'
kubectl get pvc data-postgres-0 -n prod -w
# Ver Condition FileSystemResizePending → completa
```

Downsize **no está soportado**: para reducir hay que crear un PVC nuevo más pequeño, copiar datos, borrar el original.

---

## 5. Ejemplo práctico: exponer LinguaDev Pro con Cilium Gateway API + Postgres StatefulSet

Aplicación completa sobre el proyecto real. Sustituí `linguadev.app` por tu dominio.

### Paso 1: cluster con Cilium 1.16 y Gateway API

```bash
# Kind cluster
kind create cluster --name linguadev --config kind-calico.yaml

# Habilitar Gateway API CRDs
kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.1/standard-install.yaml

# Cilium con Gateway API
helm install cilium cilium/cilium --version 1.16.5 \
  --namespace kube-system \
  --set kubeProxyReplacement=true \
  --set gatewayAPI.enabled=true \
  --set hubble.enabled=true \
  --set hubble.ui.enabled=true

# Verificar
kubectl -n kube-system get pods -l k8s-app=cilium
cilium status --wait
```

### Paso 2: namespace, deploys y Services

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: linguadev
  labels:
    gateway-access: "true"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: linguadev
spec:
  replicas: 2
  selector:
    matchLabels: { app: web }
  template:
    metadata:
      labels: { app: web }
    spec:
      containers:
        - name: web
          image: ghcr.io/linguadev/web:1.4.0
          ports: [{ containerPort: 3000 }]
          readinessProbe:
            httpGet: { path: /healthz, port: 3000 }
---
apiVersion: v1
kind: Service
metadata:
  name: web
  namespace: linguadev
spec:
  selector: { app: web }
  ports:
    - port: 80
      targetPort: 3000
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: linguadev
spec:
  replicas: 3
  selector:
    matchLabels: { app: api }
  template:
    metadata:
      labels: { app: api }
    spec:
      containers:
        - name: api
          image: ghcr.io/linguadev/api:2.1.0
          ports: [{ containerPort: 8080 }]
---
apiVersion: v1
kind: Service
metadata:
  name: api
  namespace: linguadev
spec:
  selector: { app: api }
  ports: [{ port: 80, targetPort: 8080 }]
```

### Paso 3: Gateway + HTTPRoute

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: linguadev-gw
  namespace: linguadev
spec:
  gatewayClassName: cilium
  listeners:
    - name: http
      port: 80
      protocol: HTTP
      allowedRoutes:
        namespaces:
          from: Same
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: web-route
  namespace: linguadev
spec:
  parentRefs: [{ name: linguadev-gw }]
  hostnames: ["linguadev.app"]
  rules:
    - matches: [{ path: { type: PathPrefix, value: / } }]
      backendRefs: [{ name: web, port: 80 }]
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: api-route
  namespace: linguadev
spec:
  parentRefs: [{ name: linguadev-gw }]
  hostnames: ["api.linguadev.app"]
  rules:
    - matches: [{ path: { type: PathPrefix, value: /v1 } }]
      backendRefs: [{ name: api, port: 80 }]
```

### Paso 4: Postgres StatefulSet con snapshots

```yaml
apiVersion: v1
kind: Service
metadata:
  name: postgres
  namespace: linguadev
spec:
  clusterIP: None
  selector: { app: postgres }
  ports: [{ port: 5432 }]
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: linguadev
spec:
  serviceName: postgres
  replicas: 1
  selector:
    matchLabels: { app: postgres }
  template:
    metadata:
      labels: { app: postgres }
    spec:
      containers:
        - name: postgres
          image: postgres:17.2-alpine
          env:
            - name: POSTGRES_PASSWORD
              valueFrom:
                secretKeyRef: { name: pg-secret, key: password }
            - name: PGDATA
              value: /var/lib/postgresql/data/pgdata
          volumeMounts:
            - name: data
              mountPath: /var/lib/postgresql/data
          readinessProbe:
            exec: { command: [pg_isready, -U, postgres] }
  volumeClaimTemplates:
    - metadata: { name: data }
      spec:
        accessModes: [ReadWriteOnce]
        storageClassName: gp3-fast
        resources: { requests: { storage: 50Gi } }
  persistentVolumeClaimRetentionPolicy:
    whenDeleted: Retain
    whenScaled: Retain
```

### Paso 5: NetworkPolicy: solo `api` puede hablar a `postgres`

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
  namespace: linguadev
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns
  namespace: linguadev
spec:
  podSelector: {}
  policyTypes: [Egress]
  egress:
    - to:
        - namespaceSelector:
            matchLabels: { kubernetes.io/metadata.name: kube-system }
          podSelector:
            matchLabels: { k8s-app: kube-dns }
      ports: [{ port: 53, protocol: UDP }]
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-to-postgres
  namespace: linguadev
spec:
  podSelector:
    matchLabels: { app: postgres }
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector:
            matchLabels: { app: api }
      ports: [{ port: 5432, protocol: TCP }]
```

### Paso 6: snapshot antes de migración

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: pg-pre-migration-20260813
  namespace: linguadev
spec:
  volumeSnapshotClassName: gp3-snap
  source:
    persistentVolumeClaimName: data-postgres-0
```

Verificar: `kubectl get volumesnapshot -n linguadev` debe mostrar `READYTOUSE: true`.

---

## 6. Cheatsheet + reglas mentales + anti-patrones

### Reglas de oro

- ✅ Elegí CNI **antes** del primer deploy productivo (cambiar CNI a posteriori duele).
- ✅ Usá **Gateway API** para greenfield en 2026; Ingress solo para maintenance de legacy.
- ✅ `Service` type `LoadBalancer` es caro; agrupá con Ingress/Gateway.
- ✅ Aplicá `default-deny` NetworkPolicy en namespaces sensibles + allows explícitos.
- ✅ **Nunca olvides egress a `kube-dns:53/UDP`** cuando aplicás default-deny.
- ✅ `WaitForFirstConsumer` en toda `StorageClass` de discos zonales.
- ✅ `StatefulSet` + `volumeClaimTemplates` para stateful; nunca PVC manual por réplica.
- ✅ `allowVolumeExpansion: true` en StorageClass productivo.
- ✅ `NodeLocal DNS Cache` en clusters con alta rate de queries DNS.
- ✅ Snapshots regulares con `VolumeSnapshot` + herramienta de backup (Velero).
- ✅ Namespace labels (`kubernetes.io/metadata.name`) para NetworkPolicies cross-namespace.
- ✅ `ndots:1` o FQDN con punto final en apps que hacen muchas conexiones externas.
- ✅ Cilium + Hubble si necesitás observability L7.
- ✅ Verificá `EndpointSlices` cuando "el Service no responde".

### Anti-patrones

- ❌ Un `LoadBalancer` por servicio (multiplicá el coste).
- ❌ Flannel + expectativa de NetworkPolicies.
- ❌ Hardcode de IPs de Pods (cambian en cada restart).
- ❌ Mount de PVC `ReadWriteOnce` en dos Pods (el segundo queda `Pending`).
- ❌ Borrar un `StatefulSet` esperando que se limpien PVCs sin `persistentVolumeClaimRetentionPolicy`.
- ❌ CoreDNS con 1 sola réplica (SPOF).
- ❌ NetworkPolicy sin egress DNS (todo parece "connection refused").
- ❌ Confundir `Ingress` con `Service` type LoadBalancer.
- ❌ Poner Gateway y HTTPRoute en el mismo namespace sin `allowedRoutes`.
- ❌ StorageClass sin `WaitForFirstConsumer` en cluster multi-AZ.
- ❌ Ignorar `readinessProbe`: el Service enruta a Pods no listos.

### Tabla decisión Service

| Necesidad | Tipo |
|---|---|
| App-to-app dentro del cluster | `ClusterIP` |
| Testing local, sin cloud LB | `NodePort` |
| Un solo servicio expuesto | `LoadBalancer` |
| Muchos servicios HTTP | `Ingress` o **Gateway API** |
| Legacy on-prem con MetalLB | `LoadBalancer` + MetalLB |
| Descubrir Pods individuales (SRV) | Headless (`clusterIP: None`) |
| Alias a servicio externo | `ExternalName` |

### Tabla decisión Storage

| Caso | Access mode | Driver típico |
|---|---|---|
| Postgres, MySQL replicated | RWO | EBS/GCE PD/Azure Disk |
| Assets compartidos entre pods | RWX | EFS/NFS/CephFS/Azurefile |
| Solo un Pod (más estricto) | RWOP | EBS/Ceph |
| Datasets ML gigantes | Object | Mountpoint-S3 CSI |
| Cache local rápido | Local PV | local-path-provisioner |

---

## 7. Casos reales industria 2023-2026

**Datadog Cilium migration (2023):** Datadog documentó migración de iptables kube-proxy a Cilium eBPF en clusters de miles de nodos. Redujeron latencia P99 en algunos servicios y eliminaron regresiones de iptables al crecer el número de Services. **Lección:** en clusters grandes, iptables O(n) se convierte en cuello de botella; eBPF O(1) escala.

**GKE Dataplane V2 (2021+, standard en 2024):** Google migró GKE a Cilium como opción default para nuevos clusters. Habilitó NetworkPolicies performantes y visibility con Dataplane V2 Observability. **Lección:** los hyperscalers apuestan por eBPF como base del futuro K8s networking.

**Airbnb NetworkPolicies (2023):** Airbnb estandarizó default-deny en todos los namespaces productivos. Reportaron reducción de blast radius de incidentes tipo "un microservicio compromised no puede pivotar". El coste fue educar a devs: cada nuevo Service requiere allow explícito. **Lección:** la microsegmentación es viable; requiere DX (self-service policies + tooling).

**GitLab EFS incident (2017, aún citado):** GitLab.com sufrió downtime por RWX en EFS con inconsistencias de lock cross-nodo. Migraron a RWO + replication a nivel de app. **Lección:** RWX es tentador pero introduce complejidad de coherencia; para stateful databases usá RWO + replication de la app.

**Robinhood outage 2020:** un misconfig en DNS interno propagó fallos. Post-mortem citó falta de NodeLocal DNS y saturación de CoreDNS. **Lección:** DNS es el "SPOF invisible"; NodeLocal DNS Cache + réplicas + resource limits en CoreDNS son must.

**Adobe adoption Cilium + Hubble (2022+):** Adobe compartió en KubeCon la migración a Cilium con NetworkPolicies L7 y Hubble para audit. Redujeron tickets de "por qué no funciona la red" con visibility. **Lección:** observability L7 (no solo L3/L4) transforma el troubleshooting.

**AWS Mountpoint for S3 CSI Driver (GA 2024):** AWS lanzó driver oficial para montar buckets S3 como filesystem en Pods. Usado en workloads ML para leer datasets sin copiar a EBS. **Lección:** el ecosistema CSI sigue expandiéndose a casos que antes eran "no natural fit".

**Cloudflare pingora on K8s (2024):** Cloudflare pushed Gateway API y Envoy-based ingress a escala. Contribuyeron features upstream a la spec. **Lección:** Gateway API está siendo empujada por production heavy-hitters, no es solo experimento.

**GitOps StatefulSet + Snapshots (Argo/Flux 2024):** patrón cada vez más común: `VolumeSnapshot` scheduled con Kanister o Velero, restaurable en staging para verificar migraciones. **Lección:** snapshots como parte de CI/CD, no solo backup.

**EKS Auto Mode (2024) y AKS Automatic (2024):** cloud providers ofrecen modes "managed everything" que abstraen CNI, ingress y storage class defaults. **Lección:** para equipos que no quieren tocar plumbing, managed defaults son opción; para diferenciación, elegí tu propio stack.

---

## 8. Ejercicios prácticos

### Ejercicio 1: Publicar un Service con Gateway API en Cilium

**Objetivo:** exponer un Deployment vía `Gateway` + `HTTPRoute` y validar que responde.

**Setup:**
- Cluster kind con Cilium 1.16+ y Gateway API CRDs v1.2 instaladas.
- kubectl acceso.

**Pasos:**
1. Crea Namespace `demo`.
2. Deploy `nginx:1.27` con Service ClusterIP `port: 80 → 80`.
3. Crea `Gateway` con `gatewayClassName: cilium`, listener HTTP port 80.
4. Crea `HTTPRoute` con `hostnames: ["demo.local"]`, path `/`, backend Service `nginx`.
5. Port-forward al Service del Gateway y curl con `Host: demo.local`.

**Criterios de éxito:**
- [ ] `kubectl get gateway -n demo` muestra `PROGRAMMED=True`.
- [ ] `kubectl get httproute -n demo` muestra `ACCEPTED=True`.
- [ ] `curl -H 'Host: demo.local' http://localhost:8080/` retorna HTML de nginx.
- [ ] Se detecta el flujo en Hubble UI.

**Bonus:** añade una segunda backend con `weight: 20` para probar canary.

---

### Ejercicio 2: Aplicar default-deny + allows sin romper DNS

**Objetivo:** convertir un namespace en deny-by-default sin quebrar la comunicación DNS y verificar drops en Hubble.

**Setup:**
- Namespace `secure-app` con 2 Pods (web y api) más un Pod `debug` (netshoot).
- Cilium con Hubble corriendo.

**Pasos:**
1. Aplica `default-deny` con `podSelector: {}` y `policyTypes: [Ingress, Egress]`.
2. Desde `debug`, verifica que `nslookup kubernetes.default` **falla**.
3. Aplica `allow-dns` con egress a `kube-system/kube-dns:53/UDP`.
4. Verifica que `nslookup` ahora **funciona**.
5. Aplica `web-to-api` que permite ingress al Pod `api` desde `web`.
6. Verifica desde `web` que `curl api:8080` funciona; desde `debug` **no**.

**Criterios de éxito:**
- [ ] Sin `allow-dns`, DNS falla.
- [ ] Con `allow-dns`, DNS resuelve.
- [ ] `web → api` funciona; `debug → api` falla.
- [ ] Hubble reporta `VERDICT: DROPPED` para los intentos bloqueados.

**Bonus:** añade una `CiliumNetworkPolicy` L7 que solo permita `GET /health` de `web → api`.

---

### Ejercicio 3: StatefulSet Postgres con snapshot y restore

**Objetivo:** desplegar Postgres, insertar datos, hacer snapshot, borrar y restaurar en un PVC nuevo.

**Setup:**
- CSI driver que soporte snapshots (kind + `csi-driver-host-path` con snapshotter; o EKS con EBS CSI + Snapshotter).
- `VolumeSnapshotClass` creado.

**Pasos:**
1. Deploy `postgres` StatefulSet con `volumeClaimTemplates` de 5Gi.
2. Crea tabla + insert de 10 filas.
3. Crea `VolumeSnapshot` `pg-snap-1` del PVC `data-postgres-0`.
4. Espera hasta que `READYTOUSE=true`.
5. Elimina el StatefulSet y su PVC (`kubectl delete pvc data-postgres-0`).
6. Crea PVC nuevo con `dataSource` apuntando a `pg-snap-1`.
7. Recrea el StatefulSet apuntando al PVC restaurado.
8. Query las 10 filas → deben existir.

**Criterios de éxito:**
- [ ] `VolumeSnapshot.status.readyToUse = true`.
- [ ] PVC restaurado tiene la misma capacidad.
- [ ] Postgres inicia y las filas están presentes.
- [ ] `kubectl describe pvc` referencia `dataSource`.

**Bonus:** automatiza el snapshot diario con un CronJob que use `kubectl apply -f` con timestamp.

---

### Ejercicio 4: Debug end-to-end de un Service "que no responde"

**Objetivo:** aplicar una checklist mental para diagnosticar un Service roto.

**Setup:**
- Un manifest con bug intencionado (elegí uno: `targetPort` incorrecto, `selector` que no matchea, `readinessProbe` fallando).

**Pasos:**
1. `kubectl get svc <name>` → confirmar existencia.
2. `kubectl get endpointslices -l kubernetes.io/service-name=<name>` → ver si hay endpoints.
3. Si vacío: revisar `selector` vs labels de Pods.
4. Si con endpoints pero no responde: `kubectl exec` a un Pod y `curl http://<pod-ip>:<targetPort>`.
5. `kubectl describe pod` → probes, eventos.
6. `kubectl logs` para ver si la app escucha en el puerto esperado.
7. Corregí el bug y verifica.

**Criterios de éxito:**
- [ ] Identificás la causa root en <5 minutos.
- [ ] Documentás el paso que reveló el bug.
- [ ] Corrección funciona.
- [ ] Añadís al post-mortem cómo evitarlo (ej: usar `port: X, targetPort: X` con el mismo número, tests de smoke en CI).

**Bonus:** escribí un script `bash` que corra los pasos automáticamente contra un Service.

---

### Ejercicio 5 (bonus): Migrar Ingress → Gateway API

**Objetivo:** convertir un manifest `Ingress` a Gateway API equivalente sin downtime.

**Setup:**
- Un Ingress existente con TLS + 2 hosts + 3 paths.
- Ingress Controller + Gateway API controller corriendo (pueden coexistir).

**Pasos:**
1. Anotá el manifest `Ingress` actual.
2. Crea `GatewayClass` y `Gateway` con listeners HTTPS.
3. Traducí cada `path` a `HTTPRoute` (`pathType: Prefix` → `path.type: PathPrefix`).
4. Provisiona certificado con cert-manager referenciado en `Gateway`.
5. Prueba con curl a la IP nueva del Gateway.
6. Una vez validado, cambia DNS al nuevo IP y borra Ingress.

**Criterios de éxito:**
- [ ] Gateway `PROGRAMMED=True`.
- [ ] Todos los HTTPRoutes `ACCEPTED=True`.
- [ ] Certificado TLS válido.
- [ ] Traffic sirve correctamente en la nueva ruta.
- [ ] Ingress viejo eliminado.

**Bonus:** implementá canary con `weight` a un nuevo backend.

---

## 9. Recursos + siguientes pasos

**Documentación oficial:**
- [kubernetes.io — Services, Load Balancing, Networking](https://kubernetes.io/docs/concepts/services-networking/).
- [gateway-api.sigs.k8s.io](https://gateway-api.sigs.k8s.io) — spec Gateway API v1.2.
- [kubernetes.io — Persistent Volumes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/).
- [kubernetes-csi.github.io](https://kubernetes-csi.github.io) — landing de CSI drivers.

**CNIs:**
- [cilium.io/docs](https://docs.cilium.io) — Cilium 1.16+ con Gateway API y Hubble.
- [projectcalico.org/docs](https://docs.tigera.io/calico) — Calico 3.28+.
- [github.com/flannel-io/flannel](https://github.com/flannel-io/flannel) — Flannel.

**Herramientas:**
- **Hubble** — flow observability para Cilium.
- **kubectl-netshoot** plugin para debug.
- **cilium-cli** — `cilium status`, `cilium connectivity test`.
- **Velero** — backup de cluster + PVCs.
- **cert-manager** — TLS automático con Let's Encrypt para Ingress/Gateway.

**Referencias adicionales:**
- Aya Igarashi, "*Kubernetes Networking Deep Dive*" (KubeCon EU 2024).
- Liz Rice, "*Learning eBPF*" (O'Reilly, 2023) — base conceptual de Cilium.
- Manning, "*Kubernetes Patterns*" (Ibryam & Huß, 2ª ed 2023).

**Siguientes pasos:**
- Completá los 5 ejercicios sobre LinguaDev Pro.
- Auditá tu cluster: ¿tenés `default-deny`? ¿`WaitForFirstConsumer`? ¿NodeLocal DNS?
- Migrá 1 Ingress a Gateway API en staging.
- Configurá snapshots diarios de PVCs críticos.
- Continuá con [cap 10 — Helm y Kustomize](./10-helm-y-kustomize.md) para gestionar la complejidad multi-environment.

---

## 10. Preguntas de práctica (20)

Este capítulo tiene **20 preguntas** con escenarios reales, distribuidas entre networking y storage, dificultades junior → staff. Cubren: modelo de red plano, CoreDNS y resolv.conf, comparación CNI (Cilium/Calico/Flannel), NetworkPolicy con default-deny, Service tipos y sus trade-offs, EndpointSlices, Ingress vs Gateway API, HTTPRoute con canary, PV/PVC/StorageClass, dynamic provisioning, CSI, StatefulSet con volumeClaimTemplates, snapshots, expansion, access modes, y trampas típicas.

- **Fuente:** [`packages/content/src/tech/devops/sim-09-kubernetes-networking-storage.json`](../../packages/content/src/tech/devops/sim-09-kubernetes-networking-storage.json)
- **Ruta en app:** `/programming/devops/sim/devops-sim-09-kubernetes-networking-storage`
- **Tiempo:** 30 min · **Pass:** 75% (15/20 correctas)

---

## Navegación

← [Capítulo 08 — Kubernetes Workloads](./08-kubernetes-workloads.md) · [Índice](./README.md) · [Capítulo 10 — Helm y Kustomize →](./10-helm-y-kustomize.md)

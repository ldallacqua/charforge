# Charforge

Estúdio de personagens com IA. O agente (Claude) gera as imagens de cada fase do personagem; o dono
revisa cada imagem de perto e dá o veredito com motivos clicáveis. O agente lê os vereditos e sabe
exatamente o que corrigir na próxima rodada.

A revisão humana era o gargalo: o agente produz rápido, mas deixa passar mão com dedo a mais, olho
torto, sobra de fundo no recorte. Aqui a revisão vira uma tela feita para isso, e o resultado vira
dado estruturado em vez de conversa.

## Como funciona

```
 agente                              estúdio                              dono
 ──────                              ───────                              ────
 gera as imagens da fase
 roda o QA automático
 forge submit  ───────────────────▶  lote "esperando você"  ───────────▶  revisa: lupas, zoom,
                                                                           antes e depois, fundos
 forge wait    ◀───────────────────  vereditos + plano de    ◀──────────  aprova ou recusa com
 corrige o que foi recusado          correção                              motivos e marcações
 forge submit --parent  ──────────▶  rodada 2 (só as recusadas) ...
```

- **Lote**: um conjunto de imagens de uma fase (G0 a G8, os mesmos portões do guia de QA).
  Dois tipos: **revisão** (cada imagem aprovada ou recusada) e **escolha** (várias candidatas para
  a mesma coisa, como 8 seeds de uma mão; o dono escolhe uma).
- **Lupas**: regiões que o agente marca para inspeção de perto (mãos, olhos, rosto, pés, chifres,
  asas, bordas). Cada lupa tem seu próprio veredito. Ao trocar de imagem, a lupa continua na mesma
  região: dá para conferir a mesma mão nas 5 expressões de uma pose em segundos.
- **Marcações**: o dono circula qualquer ponto da imagem (tecla P, ou Shift + arrastar) e diz o motivo.
  O agente recebe as coordenadas em pixels.
- **Motivos**: um vocabulário fixo ([`src/shared/taxonomy.ts`](src/shared/taxonomy.ts)), cada um com a
  correção que o agente deve aplicar. Aprovação também tem motivos ("excelente", "usar como referência").
- **Plano de correção**: ao enviar a revisão, os motivos são agrupados e ordenados pela frequência.
  É por onde o agente começa.

## Tela de revisão

| Recurso | Para quê |
|---|---|
| Zoom com roda ou pinça, duplo clique para pixel real | contar dedos com 400 px ou mais por mão |
| Fundos: xadrez, cinza neutro, escuro, claro, magenta, alfa | halo aparece no escuro, sobra de fundo salta no magenta, o alfa mostra o recorte puro |
| Antes e depois (tecla C), com divisória arrastável | toda correção é comparada com a rodada anterior |
| Tira de contato com marcas de lápis | ver de relance o que já foi decidido |
| Verificações automáticas na imagem | o resultado do `qa_sprites.py` aparece junto, com o que foi aceito |
| Atualização ao vivo | um lote novo aparece na hora, com aviso |
| Funciona no celular | revisar pelo telefone |

Atalhos: `A` aprova e vai para a próxima pendente, `R` recusa, `1`–`9` amplia a região, `Tab` próxima
região, `O` região OK, `C` compara, `B` troca o fundo, `P` marca um ponto, `?` mostra todos.

## Rodar

Requer Node 24 (TypeScript roda direto, sem build no servidor) e pnpm.

```bash
pnpm install
pnpm build        # interface
pnpm start        # http://127.0.0.1:8787
```

Desenvolvimento com recarga: `pnpm dev` (interface em http://localhost:5180).

Variáveis: `PORT` (8787), `HOST` (127.0.0.1), `CHARFORGE_DATA` (`./data`).

## Lado do agente: `forge`

```bash
pnpm forge char add rin --name Rin --summary "..."
pnpm forge submit --manifest lote.json          # ou: --char rin --phase g5 --title "..." imagens...
pnpm forge wait 12                              # bloqueia até o dono enviar a revisão
pnpm forge verdicts 12 --json                   # vereditos, motivos com a correção, plano
pnpm forge status
```

`FORGE_URL` aponta para o estúdio (padrão `http://127.0.0.1:8787`), então o agente pode enviar de
outra máquina. O formato do manifesto e as regras do ciclo estão em [AGENTS.md](AGENTS.md).

## Dados

Tudo fica em `data/` (banco SQLite e as imagens, que podem ser NSFW). **Nunca vai para o Git.**
Para backup, copie a pasta com o servidor parado.

## Arquitetura

| Parte | Tecnologia |
|---|---|
| Servidor | Node 24, Hono, `node:sqlite`, sharp (miniaturas WebP) |
| Interface | React 19, React Router, TanStack Query, Tailwind 4, fonte Archivo (eixo de largura) |
| Ao vivo | Server-Sent Events (`/api/events`) |
| Testes | Vitest (`pnpm test`), tipos com `pnpm typecheck` |

Visual: sala de revisão de arte. O fundo é cinza neutro de verdade (sem tom) para não enviesar a
leitura de cor; as únicas cores fortes são as marcas de lápis (vermelho recusa, verde aprova) e o
âmbar do que está em foco. As regiões aparecem como marcas de corte de gráfica.

## Próximos passos

- Rodar como serviço do homelab (Docker + Tailscale) para revisar de qualquer lugar.
- Detecção automática de mãos, rostos e pés (YOLO do Impact Pack na 4090) para criar as lupas sozinho.
- Mover o pipeline de geração (`sillytavern/charforge`) para cá, generalizado para qualquer personagem.
- Sprites mestre de corpo inteiro: a revisão de pés já está no vocabulário.

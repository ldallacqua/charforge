# Charforge

Estúdio de personagens com IA. Um agente (Claude, Codex, Gemini, qualquer um) faz o trabalho: escreve o
card, gera as imagens, treina a LoRA, monta as sprites. Você revisa cada imagem de perto, aprova ou recusa
com motivos clicáveis, e o agente corrige exatamente o que foi recusado.

A revisão humana era o gargalo: o agente produz rápido, mas deixa passar mão com dedo a mais, olho
torto, sobra de fundo no recorte. Aqui a revisão vira uma tela feita para isso, e a sua opinião vira dado
estruturado que o agente lê.

## Como funciona

```
 você                                  estúdio                               agente
 ────                                  ───────                               ──────
 cria o personagem: brief,       ─▶   personagem + perfil de geração   ─▶   forge next: o que fazer agora
 adulto, como gerar as imagens
                                                                            gera (GPU, API ou CLI), confere
 revisa: lupas, zoom, antes e    ◀─   lote "esperando você"           ◀─   forge submit
 depois, fundos; gostei/não
 gostei, aprova/recusa + motivo  ─▶   vereditos + plano de correção   ─▶   forge wait / verdicts
                                                                            corrige só o recusado, rodada 2
 conclui a fase                  ─▶   G0 … G8
```

**As fases** (G0 a G8): brief e idade, card, design (descoberta e âncoras), dataset, LoRA, sprites,
cenários e CGs, integração, aprovação. O passo a passo completo está no [playbook](docs/PLAYBOOK.md).

**Descoberta (G2).** Você escreve o brief; o agente volta com 8 a 12 conceitos bem diferentes de corpo
inteiro. Você marca "gostei" e diz do quê (rosto, cabelo, roupa, cores, silhueta, acessórios, clima,
estilo). A próxima rodada junta as partes escolhidas, até você escolher um design.

**Geração intercambiável.** Ao criar o personagem você escolhe como as imagens são geradas, e dá para
trocar depois:

| Perfil | SFW | NSFW |
|---|---|---|
| Tudo na GPU local | ComfyUI na sua placa | ComfyUI na sua placa |
| ChatGPT para SFW, GPU para NSFW | Codex CLI com o seu plano do ChatGPT (sem chave de API) | ComfyUI |
| API da OpenAI para SFW, GPU para NSFW | API de imagens (cobrada por imagem) | ComfyUI |
| Só SFW, pelo ChatGPT | Codex CLI | nenhum |

NSFW só sai da GPU local; o estúdio recusa mandar NSFW para um serviço na nuvem. Detalhes em
[docs/RENDERING.md](docs/RENDERING.md).

**Ampliação 2× em blocos.** No mestre de corpo inteiro o rosto sai pequeno (~230 px na GPU, ~175 px no
GPT); a sprite precisa de 265 px. Recortar direto amplia o recorte (1,15× a 1,5×) e borra. Por isso toda imagem aprovada é ampliada 2× antes do
recorte: ela é redesenhada em blocos sobrepostos (um deles centrado no rosto, para os olhos virem de um
desenho só) e os blocos são alinhados e juntados sem emenda, com a cor da original. O redesenho é do GPT
no SFW (o método escolhido no Siren Siege) ou do SDXL com a LoRA na GPU local, a única opção para NSFW.

**Retomar de qualquer ponto.** Todo o estado (brief, perfil, lotes, vereditos, fases) fica no estúdio.
Qualquer agente, de qualquer provedor, continua o trabalho com `forge next <personagem>`. As instruções
para agentes estão em [AGENTS.md](AGENTS.md).

## A tela de revisão

| Recurso | Para quê |
|---|---|
| Lupas nas regiões que o agente marca (mãos, olhos, rosto, pés, chifres, asas, cauda, bordas) | cada uma com veredito próprio; ao trocar de imagem a lupa fica na mesma região, para comparar a mesma mão nas 5 expressões |
| Zoom com roda ou pinça, duplo clique para pixel real | contar dedos com 400 px ou mais por mão |
| Fundos: xadrez, cinza neutro, escuro, claro, magenta, alfa | halo aparece no escuro, sobra de fundo salta no magenta, o alfa mostra o recorte puro |
| Antes e depois (tecla C), com divisória arrastável | toda correção comparada com a rodada anterior |
| Marcações (P, ou Shift + arrastar) | circular o ponto exato; o agente recebe as coordenadas |
| Modo escolha | candidatas lado a lado com o mesmo zoom; recusa com motivo direto em cada imagem |
| "Gerar mais 4 parecidas" | o mesmo pedido com sementes novas, direto do estúdio |
| "Ampliar 2×" | redesenha a imagem em blocos com o dobro da resolução (GPT no SFW, GPU local no NSFW) e devolve um lote com a original como "antes" |
| Atualização ao vivo, funciona no celular | revisar de qualquer lugar |

Atalhos: `A` aprova, `R` recusa, `1`–`9` amplia a região, `Tab` próxima região, `O` região OK, `C`
compara, `B` troca o fundo, `P` marca um ponto, `?` mostra todos.

## Rodar

Requer Node 24 e pnpm. A ampliação 2× também usa Python 3.9+ (`python3 -m venv tools/.venv &&
tools/.venv/bin/pip install -r tools/requirements.txt`); a imagem Docker já vem com ele.

```bash
pnpm install
pnpm build
pnpm start                         # http://127.0.0.1:8787
```

Com Docker: `docker compose up -d` (veja `compose.yaml`). Desenvolvimento: `pnpm dev`
(http://localhost:5180).

| Variável | Para quê |
|---|---|
| `PORT`, `HOST`, `CHARFORGE_DATA` | porta (8787), endereço (127.0.0.1) e pasta de dados (`./data`) |
| `COMFYUI_URL` | a sua GPU local (ComfyUI) |
| `OPENAI_API_KEY` | a API de imagens da OpenAI (só no ambiente, nunca no estúdio) |
| `CODEX_BIN` | o Codex CLI, se não for achado sozinho |
| `CHARFORGE_PYTHON` | Python com numpy, pillow e OpenCV 4 para a ampliação (achado sozinho em `tools/.venv`) |
| `CHARFORGE_WORKER_BACKENDS` | backends que o próprio servidor roda (ex.: `comfyui,openai`) |

O Codex CLI roda na máquina onde está instalado: lá, `pnpm forge worker` pega os pedidos de geração.

## Dados

Tudo fica em `data/` (banco SQLite e as imagens, que podem ser NSFW). **Nunca vai para o Git.** Para
backup, copie a pasta com o servidor parado.

## Por dentro

| Parte | Tecnologia |
|---|---|
| Servidor | Node 24 (TypeScript nativo), Hono, `node:sqlite`, sharp |
| Interface | React 19, React Router, TanStack Query, Tailwind 4, fonte Archivo (eixo de largura) |
| Geração | `src/render/`: ComfyUI, OpenAI, Codex CLI, comando local; fila de jobs com workers |
| Ferramentas | Python em `tools/`: QA de sprites, folhas ampliadas, recorte |
| Testes | Vitest (`pnpm test`), tipos com `pnpm typecheck` |

Visual: sala de revisão de arte. O fundo é cinza neutro de verdade, para não enviesar a leitura de cor;
as únicas cores fortes são as marcas de lápis (vermelho recusa, verde aprova) e o âmbar do que está em
foco. As regiões aparecem como marcas de corte de gráfica.

## Documentação

- [AGENTS.md](AGENTS.md): instruções para qualquer agente (comece por aqui se você é um)
- [docs/PLAYBOOK.md](docs/PLAYBOOK.md): o processo completo, fase a fase
- [docs/RENDERING.md](docs/RENDERING.md): backends, perfis, workers, resolução e transparência
- [docs/MODELS.md](docs/MODELS.md): modelos e licenças
- [docs/SILLYTAVERN.md](docs/SILLYTAVERN.md): instalar o personagem no SillyTavern

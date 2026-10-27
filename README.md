# 🎩 MAGNATA — tabuleiro online com os amigos

Jogo de compra e venda de cidades, multiplayer em tempo real (2 a 6 jogadores), rodando 100% no **Cloudflare Workers + Durable Objects** (cabe no plano grátis).

## O que tem
- Salas com código de 5 letras + link de convite
- Dados 3D animados, peões andando casa por casa, cartas que viram, dinheiro voando, sons e confete
- Compra de cidades, aluguel (dobra com o grupo completo), casas e hotéis, hipoteca
- Estações, companhias, impostos, cartas **Sorte** e **Surpresa**, prisão (fiança, carta ou dupla)
- Dívidas, falência e vencedor
- Negociação de imóveis e dinheiro entre jogadores
- Chat, emotes, histórico, reconexão automática (pode dar F5 sem perder a vaga)
- Funciona no celular

## Colocar no ar (uma vez só)

Precisa do [Node.js](https://nodejs.org) 18 ou mais novo e de uma conta grátis na Cloudflare.

```bash
# 1. dentro da pasta do projeto
npm install

# 2. entrar na sua conta Cloudflare (abre o navegador)
npx wrangler login

# 3. publicar
npx wrangler deploy
```

No fim aparece um link tipo `https://magnata.SEU-USUARIO.workers.dev`. Mande pros amigos, alguém cria a sala e copia o link de convite.

> Se for a primeira vez usando Workers, a Cloudflare pede para escolher um subdomínio `workers.dev` — é só aceitar.

## Testar no seu PC antes

```bash
npx wrangler dev
```
Abra `http://localhost:8787` em duas abas (ou no celular na mesma rede) para simular dois jogadores.

## Estrutura
```
src/index.js       servidor: Worker + Durable Object (todas as regras)
public/board.js    tabuleiro, preços, aluguéis e cartas (edite à vontade!)
public/app.js      interface, animações e sons
public/style.css   visual
public/index.html  telas
wrangler.jsonc     configuração da Cloudflare
```

## Personalizar
- **Cidades, preços e cartas:** `public/board.js`
- **Dinheiro inicial / salário / fiança:** topo de `src/index.js` (`START_MONEY`, `GO_SALARY`, `JAIL_FINE`)
- Depois de mudar, rode `npx wrangler deploy` de novo.

Salas paradas por 3 dias são apagadas automaticamente.

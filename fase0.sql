-- =====================================================================
--  FASE 0 — stelle ereditate, offline, zero rete.
--  Regola A: host del link web == host della homepage_url di un repo
--  Regola B: <owner>.github.io[/<repo>]
--  Guardie:  host rivendicato da 2+ repo  -> scartato
--            host in blacklist aggregatori -> scartato
--  Tier:     1 github.io | 2 radice del dominio | 3 pagina interna
-- =====================================================================
.mode column
.headers on
pragma temp_store = memory;

-- ---------------------------------------------- host+path dei link web
create temp table web_host as
with
w0 as (select id, url, replace(replace(lower(url),'https://',''),'http://','') as rest
       from target where kind='web'),
w1 as (select id, url,
         case when instr(rest,'/')>0 then substr(rest,1,instr(rest,'/')-1) else rest end as h,
         case when instr(rest,'/')>0 then substr(rest,instr(rest,'/')+1)   else ''   end as path
       from w0),
w2 as (select id, url, path,
         case when instr(h,':')>0 then substr(h,1,instr(h,':')-1) else h end as h
       from w1),
w3 as (select id, url, path,
         case when h like 'www.%' then substr(h,5) else h end as host,
         case when instr(path,'/')>0 then substr(path,1,instr(path,'/')-1) else path end as seg1
       from w2)
select id as web_id, url as web_url, host, path,
       case when instr(seg1,'?')>0 then substr(seg1,1,instr(seg1,'?')-1)
            when instr(seg1,'#')>0 then substr(seg1,1,instr(seg1,'#')-1)
            else seg1 end as seg1,
       -- radice = path vuoto, '/', o solo query/anchor
       case when trim(replace(replace(path,'?',''),'#','')) = '' then 1 else 0 end as is_root
from w3;
create index ix_wh on web_host(host);

-- ------------------------------------- host della homepage_url dei repo
create temp table gh_host as
with
g0 as (select id, stars, replace(replace(lower(trim(homepage_url)),'https://',''),'http://','') as rest
       from target where kind='github' and homepage_url is not null and trim(homepage_url)<>''),
g1 as (select id, stars,
         case when instr(rest,'/')>0 then substr(rest,1,instr(rest,'/')-1) else rest end as h
       from g0),
g2 as (select id, stars,
         case when instr(h,':')>0 then substr(h,1,instr(h,':')-1) else h end as h
       from g1)
select distinct id as repo_id, stars,
       case when h like 'www.%' then substr(h,5) else h end as host
from g2 where h <> '';
create index ix_gh on gh_host(host);

create temp table repo_lc as
  select lower(id) as k, id as repo_id, stars from target where kind='github';
create index ix_rl on repo_lc(k);

-- ------------------------------ host rivendicati da piu' di un repo
create temp table shared as
  select host, count(*) as claimants from gh_host group by host having count(*)>1;
create index ix_sh on shared(host);

-- ------------------------------ aggregatori: un repo li rivendica, ma
--                                il dominio non e' suo
create temp table blacklist(host text primary key);
insert into blacklist values
 ('amzn.to'),('amazon.com'),('shop.oreilly.com'),('oreilly.com'),('leanpub.com'),
 ('zhihu.com'),('speakerdeck.com'),('slideshare.net'),('open.spotify.com'),
 ('telegram.me'),('t.me'),('discord.com'),('discord.gg'),('slack.com'),
 ('developer.mozilla.org'),('mozilla.org'),('stackoverflow.com'),('reddit.com'),
 ('wikipedia.org'),('en.wikipedia.org'),('linkedin.com'),('facebook.com'),
 ('goo.gl'),('bit.ly'),('tinyurl.com'),('ow.ly'),('buff.ly'),('dub.sh'),
 ('gist.github.com'),('gitlab.com'),('bitbucket.org'),('sourceforge.net'),
 ('apps.apple.com'),('itunes.apple.com'),('play.google.com'),('microsoft.com'),
 ('azure.microsoft.com'),('cloud.google.com'),('docs.cloud.google.com'),
 ('aws.amazon.com'),('groups.google.com'),('docs.google.com'),('forms.gle');

-- =============================== A) match sull'host della homepage ====
create temp table m_home as
select w.web_id, w.web_url, w.is_root, g.repo_id, g.stars, w.host as via,
       case when w.is_root=1 then 2 else 3 end as tier
from web_host w
join gh_host g   on g.host = w.host
left join shared s    on s.host = w.host
left join blacklist b on b.host = w.host
where s.host is null and b.host is null;

-- =============================== B) <owner>.github.io[/<repo>] ========
create temp table m_pages as
select w.web_id, w.web_url, w.is_root, r.repo_id, r.stars, w.host as via, 1 as tier
from web_host w
join repo_lc r
  on r.k = substr(w.host, 1, length(w.host)-10) || '/' ||
           (case when w.seg1='' then w.host else w.seg1 end)
where w.host like '%.github.io' and w.host not like '%.%.github.io';
create index ix_mp on m_pages(web_id);

-- =============================== unione, github.io ha precedenza ======
create temp table m_all as
  select * from m_pages
  union all
  select h.* from m_home h left join m_pages p on p.web_id = h.web_id
  where p.web_id is null;
create index ix_ma on m_all(web_id);

-- =====================================================================

-- =====================================================================
.print '=== RIEPILOGO ==='
select tier,
       case tier when 1 then 'github.io'
                 when 2 then 'radice del dominio'
                 else 'pagina interna' end                as regola,
       count(*)                                           as link,
       count(distinct repo_id)                            as repo,
       sum(stars)                                         as stelle
from m_all group by tier
union all select 9,'TOTALE', count(*), count(distinct repo_id), sum(stars) from m_all;

.print ''
.print '=== righe di lista coperte ==='
select count(*) as righe, count(distinct list_id) as liste
from awesome_item i join m_all m on m.web_id = i.target_id;

.print ''
.print '=== IN FACCIA ==='
.width 4 60 38 8 5
select m.tier, m.web_url, m.repo_id as repo, m.stars,
       (select count(distinct list_id) from awesome_item i where i.target_id = m.web_id) as liste
from m_all m
order by m.tier, m.stars desc;

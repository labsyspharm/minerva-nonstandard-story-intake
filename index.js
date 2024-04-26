import fs from 'fs'
import path from 'path'
import assert from 'assert'
import readline from 'readline'
import { fileURLToPath } from 'url';
// Create a readable stream
import rehypeParse from 'rehype-parse'
import ast from 'abstract-syntax-tree'
import rehypeConcatJavaScript from 'rehype-concat-javascript'
import rehypePresetMinify from 'rehype-preset-minify'
import rehypeStringify from 'rehype-stringify'
import {unified} from 'unified'


const createName = (line) => {
  const line_url = new URL('.', line);
  const full_path = line_url.pathname;
  const path_parts = full_path.slice(0,-1).split('/');
  const { parents, name } = (() => {
    if (line.endsWith('/index.html')) {
      return {
        parents: [...path_parts].slice(0, -1),
        name: [...path_parts].pop()
      }
    }
    return {
      parents: [...path_parts],
      name: line.split('/').pop().split('.').shift()
    }
  })();
  return {
    href: line_url.href,
    collection: parents.filter((part) => {
      if (part.includes('.')) {
        return false;
      }
      return ![
        'minerva', 'minerva-story', 'stories'
      ].includes(part.toLowerCase())
    }).pop(),
    name
  }
}

const extract_called_exhibit = (line, script_nodes) => {
  const assignments = script_nodes.filter(node => {
    if (node.type != 'ExpressionStatement') {
      return false;
    }
    return node.expression.type=='AssignmentExpression';
  });
  const call_node = assignments.map(node => {
    return node.expression.right;
  }).find(node => {
    return node.type=='CallExpression'
  });
  return (node => {
    if (node == undefined) {
      return undefined;
    }
    const possible_sources = node.arguments[0].properties;
    const properties = possible_sources.filter(property => {
        return property.key.name == 'exhibit'
    });
    const property = properties[0];
    if ( property.value.type == 'ObjectExpression' ) {
      const exhibit = ast.serialize(property.value);
      return { exhibit }
    }
    const url = new URL(property.value.value, line)
    return { url }
  })(call_node);
}

const extract_declared_exhibit = (script_nodes) => {
  const declarations = script_nodes.filter(node => {
    if (node.type!='VariableDeclaration') return false;
    return node.declarations.length == 1;
  }).map(node => {
    const init = node.declarations[0].init;
    return {
      name: node.declarations[0].id.name,
      value: init.value ? init.value : (
        ast.serialize(init)
      )
    };
  });
  const image_path = declarations.find(declaration => {
    return declaration.name == 'image_path';
  })?.value;
  const exhibit = declarations.find(declaration => {
    return declaration.name == 'exhibit';
  })?.value;
  if (image_path?.length > 0) {                              
    exhibit.Images.forEach(img => img.Path = image_path);   
  }
  return exhibit
}

const parse_file = async (line, text_promise) => {
  const text = await text_promise;
  const file = await (
    unified().use(rehypeParse).use(rehypePresetMinify).use(rehypeConcatJavaScript).parse(text)
  )
  return await new Promise((resolve, reject) => {
    const { name, href, collection } = createName(line);
    const html = file.children.find(el => el.tagName == 'html');
    const body = html.children.find(el => el.tagName == 'body');
    // Note: relies on coincidence that only Minerva Scripts have no properties
    const script = body.children.filter(el => el.tagName == 'script').find(el => {
      return Object.keys(el.properties).length == 0;
    });
    assert.ok(!!script, 'missing script tag');
    const script_text = script.children.find(el => el.type == 'text');
    const script_nodes = ast.parse(script_text.value).body;
    const declared_exhibit = extract_declared_exhibit(
      script_nodes 
    );
    if (declared_exhibit) {
      return resolve({
        name, href, collection, exhibit: declared_exhibit
      });
    }
    const called = extract_called_exhibit(
      line, script_nodes
    );
    if (called.exhibit) {
      return resolve({
        name, href, collection, exhibit: called.exhibit
      });
    }
    return fetch(called.url).then(res => {
      return res.json();
    }).then(exhibit => {
      return resolve({
        name, href, collection, exhibit
      });
    }).catch(e => {
      reject(e);
    });
  });
}

const read_stories = async (urls_txt) => {
  const lines = await new Promise((resolve) => {
    fs.readFile(urls_txt, {encoding: 'utf-8'}, (err,data) => {
      resolve(data.split('\n').filter(line => line));
    });
  });
  const file_promises = lines.map((line) => {
    return fetch(line).then(res => {
      return { line, text: res.text() };
    });
  })
  const file_texts = await Promise.all(file_promises);
  const exhibit_promises = file_texts.map(({ line, text }) => {
    return parse_file(line, text).catch(e => {
      console.error(e);
    });
  })
  return (await Promise.all(exhibit_promises)).map(parsed => {
    const exhibit = proofread_exhibit(
      parsed.exhibit, parsed.href
    );
    return {...parsed, exhibit};
  });
}

const proofread_exhibit = (exhibit, href) => {
    assert.ok(
      !!exhibit.Images, 'missing images'
    );
    const images = [ ...exhibit.Images ];
    const image = { ...exhibit.Images[0] };
    const current_name = image.Description;
    const misplaced_name = exhibit.Name;
    if ( !current_name ) {
      image.Description = misplaced_name || '';
    }
    image.Path = (
      new URL(image.Path, href)
    ).href.replace(/\/+$/,'');
    images[0] = image;
    return {
      ...exhibit, Images: images 
    }
}

const group_collections = (stories) => {
  const collections = stories.reduce((obj, story) => {
    const collection = obj[story.collection] || {};
    assert.ok(
      !(story.name in collection),
      `duplicate story name: ${story.name}`
    );
    collection[story.name] = {
      exhibit: story.exhibit,
      href: story.href
    };
    obj[story.collection] = collection;
    return obj;
  },{});
  return collections;
}

async function createDir(path) {
  fs.mkdirSync(path, { recursive: true });
}

const create_json_subdir = (
  out_json_dir, minerva_nominal_version,
  collection, story
) => {
  if (minerva_nominal_version == 'minerva-1-0') {
    const out_json_subdir = path.join(
      out_json_dir, `config-${collection}`
    );
    createDir(out_json_subdir);
    return path.join(
      out_json_subdir, `${story}.json`
    )
  }
  else if (minerva_nominal_version == 'minerva-1-5') {
    const out_json_subdir = path.join(
      out_json_dir, `config-${collection}`, story
    );
    createDir(out_json_subdir);
    return path.join(
      out_json_subdir, 'exhibit.json'
    )
  }
  assert.ok(false, `unsupported: ${minerva_nominal_version}`)
}

read_stories('urls.txt').then((stories) => {
  const domain = 'https://www.cycif.org';
  const collections = group_collections(stories);
  Object.entries(collections).forEach(([k, v]) => {
    //console.log(`${k}: `, Object.keys(v).join(','), '\n');
  });
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const out_json_dir = path.join(__dirname, '_data');
  const out_yaml_dir = path.join(__dirname, 'data');
  Object.entries(collections).forEach((item_i) => {
    const [ collection, stories ] = item_i;
    const out_yaml_subdir = path.join(
      out_yaml_dir, `${collection}`
    );
    createDir(out_yaml_subdir);
    Object.entries(stories).forEach((item_j) => {
      const [ story, story_details ] = item_j;
      const { exhibit, href } = story_details;
      const minerva_nominal_version = 'minerva-' + (
        ('Channels' in exhibit) ? '1-5' : '1-0'
      )
      const out_json_path = create_json_subdir(
        out_json_dir, minerva_nominal_version,
        collection, story
      )
      const out_yaml_path = path.join(
        out_yaml_subdir, `${story}.md`
      );
      assert.ok(
        !!exhibit.Images, 'missing images'
      );
      const image = exhibit.Images[0];
      const name = image.Description || story;
      assert.ok(!!image?.Path, 'missing image path');
      const image_path = image.Path ? `
image: ${image.Path}` : '';
      const out_yaml = {
'minerva-1-0': `---
title: "${name}${image_path}"
layout: osd-exhibit
paper: config-${collection}
figure: ${story}
---`,
'minerva-1-5': `---
title: "${name}${image_path}"
layout: minerva-1-5 
exhibit: config-${collection}/${story}
---`
      }[minerva_nominal_version];
      console.log(`${href},${domain}/${collection}/${story}`)
//      console.log(out_yaml);
      const out_json = JSON.stringify(exhibit);
      fs.writeFileSync(out_json_path, out_json);
      fs.writeFileSync(out_yaml_path, out_yaml);
    });
  });
});

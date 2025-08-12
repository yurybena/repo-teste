import dayjs from "dayjs";
import { deleteFile } from "../../config/file";
import { prisma } from "../../utils/prisma";
import { Request, Response } from "express";
import nodemailer from "nodemailer";
import { uploadImageWebpToS3 } from "../../utils/S3/uploadFIleS3";
import { getPresignedUrl } from "../../utils/S3/getPresignedUrl";
import S3Storage from "../../utils/S3/s3Storage";
import { createPreviewContract } from "../../templateEmail/createPreviewContract";
import { generatePdf } from "../../utils/generatePdf";
import fs from "fs";
import { calcularHorasTrabalhadas, convertHHMMToDecimal } from "../../utils/calculaHoraExtra";
import { isMultiCompanyEnabled } from "../../helpers/featureToggle";


export interface INewProject {
  seller_user_id: string;
  price: number;
  status_project: string;
  type_category: string;
  company_id: string;
  client: IClientData;
  location?: string;
  lat?: string;
  log?: string;
  radius?: string;
  start_date?: string;
  deadline?: string;
}

export interface IClientData {
  name: string;
  email: string;
  phone: string;
  birth_date: string;
  start_date: string;
}

export interface IServicesData {
  id_project: string;
  id_service: string;
  name: string;
  description: string;
  hours: number;
  price: number;
  company_id: string;
}

export interface IputServiceData extends IServicesData {
  id: string;
}

export class ProjectController {
  // Cache simples em memória para consultas frequentes
  private static cache = new Map<string, { data: any; timestamp: number }>();
  private static CACHE_TTL = 30000; // 30 segundos

  private static getCacheKey(query: any, page: number): string {
    return JSON.stringify({ query, page });
  }

  private static getFromCache(key: string) {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data;
    }
    this.cache.delete(key);
    return null;
  }

  private static setCache(key: string, data: any) {
    // Limpar cache antigo periodicamente
    if (this.cache.size > 100) {
      const now = Date.now();
      for (const [k, v] of this.cache.entries()) {
        if (now - v.timestamp > this.CACHE_TTL) {
          this.cache.delete(k);
        }
      }
    }
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  async getAllProjects(req: Request, res: Response) {
    const { company_id, id_seller, status_project, page, search } = req.query;
    const query: any = {};

    if (!company_id)
      return res.status(404).json({ error: "Company_id is required!" });

    if (company_id) query.company_id = { equals: String(company_id) };
    if (id_seller) query.seller_user_id = { equals: id_seller };

    if (status_project) {
      const statusArray =
        typeof status_project === "string"
          ? status_project.split(",")
          : [status_project];
      query.status_project = { in: statusArray };
    }

    if (search) {
      query.OR = [
        {
          contract_number: {
            equals: Number(search),
          },
        },
        {
          client: {
            name: {
              contains: search,
            },
          },
        },
        {
          user: {
            name: {
              contains: search,
            },
          },
        },
        {
          location: {
            // Alterado de client.location para project.location
            contains: search,
          },
        },
      ];
    }

    const take = 30;
    const pageNumber = Number(page);
    const skip = pageNumber * take;

    // Verificar cache
    const cacheKey = ProjectController.getCacheKey(query, pageNumber);
    const cached = ProjectController.getFromCache(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    try {
      // Consulta otimizada com includes seletivos
      const projects = await prisma.project.findMany({
        where: query,
        select: {
          id: true,
          contract_number: true,
          status_project: true,
          date_creation: true,
          date_update: true,
          seller_user_id: true,
          company_id: true,
          location: true,
          client: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              location: true,
            }
          },
          user: {
            select: {
              id: true,
              avatar: true,
              email: true,
              name: true,
            },
          },
          // Usar aggregações do Prisma para cálculos pesados
          serviceProject: {
            select: {
              id: true,
              name: true,
              description: true,
              hours: true,
              price: true,
              stages: true,
            }
          },
          _count: {
            select: {
              serviceProject: true,
              workedHours: true,
            }
          }
        },
        skip,
        take,
        orderBy: {
          date_update: "desc",
        },
      });

      if (projects.length === 0) {
        const result = { projects: [], total: 0, amount: 0 };
        ProjectController.setCache(cacheKey, result);
        return res.json(result);
      }

      // Buscar todos os dados pesados em uma única consulta batch
      const projectIds = projects.map(p => p.id);

      // Batch query para estimates - resolver N+1
      const [estimates, invoiceCosts, workedHoursAgg] = await Promise.all([
        prisma.estimate.findMany({
          where: {
            projectId: { in: projectIds }
          },
          select: {
            id: true,
            status: true,
            projectId: true,
            serviceProjects: true,
            canceledBy: {
              select: {
                id: true,
                name: true,
                email: true
              }
            },
            timelineEvents: {
              select: {
                id: true,
                description: true,
                date_creation: true,
              },
              orderBy: {
                date_creation: 'asc'
              }
            },
            emailLogs: {
              select: {
                id: true,
                date_creation: true,
              },
              orderBy: {
                date_creation: 'asc'
              }
            },
          },
          orderBy: {
            date_creation: 'desc'
          }
        }),

        // Batch query para custos de material
        prisma.invoiceCostProject.findMany({
          where: {
            project: {
              id: { in: projectIds }
            }
          },
          select: {
            project_id: true,
            costProject: {
              select: {
                price: true,
                amout: true,
              }
            }
          }
        }),

        // Batch query para horas trabalhadas agregadas
        prisma.workedhours.groupBy({
          by: ['project_id'],
          where: {
            project_id: { in: projectIds }
          },
          _sum: {
            amount_of_hours: true,
            hourly_price: true,
          },
          _count: {
            name_user: true,
          }
        })
      ]);

      // Criar maps para lookups O(1)
      const estimatesMap = new Map<string, any[]>();
      estimates.forEach((est: any) => {
        if (!estimatesMap.has(est.projectId)) {
          estimatesMap.set(est.projectId, []);
        }
        estimatesMap.get(est.projectId)!.push(est);
      });

      const costsMap = new Map<string, number>();
      invoiceCosts.forEach((invoice: any) => {
        const projectId = invoice.project_id;
        const currentCost = costsMap.get(projectId) || 0;
        const invoiceCost = invoice.costProject.reduce((total: number, cost: any) => {
          return total + Number(cost.price) * Number(cost.amout);
        }, 0);
        costsMap.set(projectId, currentCost + invoiceCost);
      });

      const workedHoursMap = new Map<string, any>();
      workedHoursAgg.forEach((wh: any) => {
        workedHoursMap.set(wh.project_id, wh);
      });

      // Montar resultado otimizado
      const projectsWithCalculations = projects.map(project => {
        const projectEstimates = estimatesMap.get(project.id) || [];
        const costOfWork = costsMap.get(project.id) || 0;
        const workedHoursData = workedHoursMap.get(project.id);

        const totalCostOfServiceHours = workedHoursData?._sum?.hourly_price || 0;
        const totalNumberOfHoursWorked = workedHoursData?._sum?.amount_of_hours || 0;
        const workersOnThisProject = workedHoursData?._count?.name_user || 0;

        // Cálculo do preço do projeto (mais eficiente)
        const priceProject = project.serviceProject.reduce((total, service) => {
          return total + Number(service.hours) * Number(service.price);
        }, 0);

        return {
          ...project,
          client: {
            ...project.client,
            location: project.location, // Substitui client.location por project.location
          },
          costofwork: costOfWork,
          cost_of_service_hours: totalCostOfServiceHours,
          total_number_of_hours_worked: totalNumberOfHoursWorked,
          workers_on_this_project: workersOnThisProject,
          price_project: priceProject,
          estimates: projectEstimates
        };
      });

      // Consulta do total apenas uma vez
      const total = await prisma.project.count({
        where: query,
      });

      let amount = pageNumber * take + projectsWithCalculations.length;
      if (amount > total) {
        amount = total;
      }

      const result = { projects: projectsWithCalculations, total, amount };

      // Cachear resultado
      ProjectController.setCache(cacheKey, result);

      return res.json(result);
    } catch (error) {
      if (error instanceof Error) {
        return res.json({ error: error.message });
      }
      return res.json({ error: "Erro interno do servidor" });
    }
  }

  async getProjectById(req: Request, res: Response) {
    const { id } = req.params;
    try {
      const project = await prisma.project.findUnique({
        where: { id },

        include: {
          client: true,

          serviceProject: {
            include: {
              UserServiceProject: {
                select: {
                  id: true,
                  user_attendances: {
                    include: {
                      user: {
                        select: {
                          hourly_price: true
                        },
                      }
                    }
                  },
                  user: {
                    select: {
                      name: true,
                      id: true,
                      avatar: true,
                    },
                  },
                },
              },
              galleryAlfter: true,
              galleryBefore: true,
              stages: true,
              service: true,
              Project: true,
              photos: true,
              Activities: true,
              costProject: {
                include: {
                  invoiceCostProject: true,
                  ServiceProject: {
                    include: {
                      service: true,
                    },
                  },
                },
              },
            },
          },
          invoiceCostProject: {
            include: {
              costProject: true,
            },
          },
          workedHours: true,
          user: {
            select: {
              id: true,
              avatar: true,
              email: true,
              name: true,
            },
          },
        },
      });

      if (project) {
        const costProjects = await Promise.all(
          project.serviceProject.flatMap(async (serviceProject) =>
            Promise.all(
              serviceProject.costProject.map(async (cost) => ({
                id: cost.id,
                material_name: cost.material_name,
                transaction_type: cost.transaction_type,
                price: cost.price,
                amout: cost.amout,
                service_project_id: cost.ServiceProject?.id,
                service_project_name: cost.ServiceProject?.name,
                invoice_cost_project_id: cost.invoiceCostProject?.id,
                project_cost_invoice_exists: cost.invoiceCostProject?.project_cost_invoice_exists,
                invoice_cost_project: await getPresignedUrl(
                  String(cost.invoiceCostProject?.uri)
                ),
              }))
            )
          )
        );
        const flatCostProjects = costProjects.flat(); // Achata o array de arrays em um único array

        let costofwork = project.invoiceCostProject.reduce(
          (total, invoice) => {
            const costSum = invoice.costProject.reduce((subtotal, cost) => {
              if (cost.transaction_type === "Cost") {
                return subtotal + Number(cost.price) * Number(cost.amout);
              } else if (cost.transaction_type === "Credit") {
                return subtotal - Number(cost.price) * Number(cost.amout);
              }
              return subtotal;
            }, 0);
            return total + costSum;
          },
          0
        );
        const userAttendance = project.serviceProject.reduce((total, service) => {
          const costTotal = service.UserServiceProject.reduce((subTotal, userService) => {
            const costSub = userService.user_attendances.reduce((sub, attendance) => {
              let hoursWorked = 0;
              let regularHours = 0;
              let overtimeHours = 0;

              if (attendance.check_out_time && attendance.check_in_time) {
                const hours = calcularHorasTrabalhadas(
                  attendance.check_in_time.toISOString(),
                  attendance.check_out_time.toISOString(),
                  attendance.workStartTime,
                  attendance.workEndTime,
                );
                regularHours = convertHHMMToDecimal(hours.normais);
                overtimeHours = convertHHMMToDecimal(hours.extras);
              }
              return sub + ((regularHours * (attendance.user.hourly_price || 0)) + (overtimeHours * (attendance.user.hourly_price || 0) * 1.5))

            }, 0)
            return subTotal + costSub
          }, 0);
          return total + costTotal
        }, 0)
        const userAttendanceHours = project.serviceProject.reduce((total, service) => {
          const costTotal = service.UserServiceProject.reduce((subTotal, userService) => {
            const costSub = userService.user_attendances.reduce((sub, attendance) => {
              let hoursWorked = 0;
              if (attendance.check_out_time) {
                hoursWorked = dayjs(attendance.check_out_time).diff(dayjs(attendance.check_in_time), 'hour', true);
              }
              return sub + parseFloat(hoursWorked.toFixed(2))

            }, 0)
            return subTotal + costSub
          }, 0);
          return total + costTotal
        }, 0)

        let totalCostOfServiceHours = 0;
        let totalNumberOfHoursWorked = 0;
        const uniqueUsers = new Set();

        project.workedHours.forEach((workedHour) => {
          if (workedHour.amount_of_hours !== null) {
            totalCostOfServiceHours +=
              Number(workedHour.amount_of_hours) *
              Number(workedHour.hourly_price);
            totalNumberOfHoursWorked += Number(workedHour.amount_of_hours);
          } else {
            totalCostOfServiceHours += Number(workedHour.hourly_price);
          }
          uniqueUsers.add(workedHour.name_user);
        });

        const workersOnThisProject = uniqueUsers.size;
        // costofwork += userAttendance
        // Calcula o somatório de hours * price
        const priceProject = project.serviceProject.reduce((total, service) => {
          return total + Number(service.hours) * Number(service.price);
        }, 0);

        // Processar as URLs das fotos para adicionar uriTreated
        if (project.serviceProject) {
          for (const service of project.serviceProject) {
            if (service.photos) {
              service.photos = await Promise.all(
                service.photos.map(async (photo) => {
                  const uriTreated = await getPresignedUrl(photo.uri);
                  return {
                    ...photo,
                    uriTreated
                  };
                })
              );
            }
          }
        }

        res.json({
          ...project,
          client: {
            ...project.client,
            location: project.location, // Substitui client.location por project.location
          },
          user: {
            ...project.user,
            avatar: project.user?.avatar
              ? await getPresignedUrl(String(project.user?.avatar))
              : null,
          },
          costProjects: flatCostProjects,
          cost_of_materials: costofwork,
          cost_of_service_hours: totalCostOfServiceHours + userAttendance,
          total_number_of_hours_worked: totalNumberOfHoursWorked + userAttendanceHours,
          workers_on_this_project: workersOnThisProject,
          price_project: priceProject, // Adiciona o novo campo price_project
        });
      } else {
        res.status(404).json({ error: "Project not found" });
      }
    } catch (error) {
      if (error instanceof Error) {
        return res.json({ error: error.message });
      }
      return res.json({ error: "Erro interno do servidor" });
    }
  }

  async createServiceProject(req: Request, res: Response) {
    const data: IServicesData = req.body;

    try {
      const result = await prisma.serviceProject.create({
        data: {
          id_service: data.id_service || null,
          projectId: data.id_project,
          description: data.description,
          hours: data.hours,
          name: data.name,
          price: data.price,
          company_id: data.company_id,
        },
      });
      return res.json(result);
    } catch (error) {
      if (error instanceof Error) {
        return res.json({ error: error.message });
      }
      return res.json({ error: "Erro interno do servidor" });
    }
  }

  //novo updateserviceProject
  async updateServiceProject(req: Request, res: Response) {
    const data: IputServiceData = req.body;
    console.log(data);
    try {
      // Verificar se o serviço existe
      const serviceExists = await prisma.serviceProject.findUnique({
        where: {
          id: data.id,
        }
      });

      if (!serviceExists) {
        return res.status(400).json({ error: "Serviço não encontrado" });
      }

      // Atualizar o serviço
      let result;
      if (!data.id_service) {
        result = await prisma.serviceProject.update({
          where: {
            id: data.id,
          },
          data: {
            name: data.name,
            description: data.description,
            hours: data.hours,
            price: data.price,
          },
        });
      } else {
        result = await prisma.serviceProject.update({
          where: {
            id: data.id,
          },
          data: {
            name: data.name,
            description: data.description,
            hours: data.hours,
            price: data.price,
          },
        });
      }

      // Se temos id_project e description, atualizar os InvoiceItems relacionados
      if (data.id_project && data.description) {
        // Buscar todas as faturas do projeto
        const invoices = await prisma.invoice.findMany({
          where: {
            projectId: data.id_project
          },
          include: {
            InvoiceItems: true
          }
        });

        // Para cada fatura, atualizar os itens que correspondem ao nome do serviço
        for (const invoice of invoices) {
          for (const item of invoice.InvoiceItems) {
            if (item.name === serviceExists.name) {
              await prisma.invoiceItem.update({
                where: { id: item.id },
                data: {
                  description: data.description
                }
              });
              console.log(`Atualizada descrição do item ${item.id} na fatura ${invoice.id}`);
            }
          }
        }
      }

      return res.json(result);
    } catch (error) {
      if (error instanceof Error) {
        return res.status(500).json({ error: error.message });
      }
      return res.status(500).json({ error: "Erro interno do servidor" });
    }
  }
  // novo delete imgServiceProject
  constructor() {
    this.deleteFiles = this.deleteFiles.bind(this);
    this.DeleteAllImgServiceProjectController =
      this.DeleteAllImgServiceProjectController.bind(this);
    this.deleteServiceProject = this.deleteServiceProject.bind(this);
  }
  // constructor() {
  //   this.handle = this.handle.bind(this);
  //   this.deleteFiles = this.deleteFiles.bind(this);
  // }

  // deleteFiles(file: string, requestFile: string | undefined) {
  //   deleteFile(`./public/tmp/service-project${file}`);
  //   deleteFile(`./public/tmp/service-project${requestFile}`);
  // }
  async deleteFiles(file: string) {
    const s3 = new S3Storage();
    await s3.deleteFile(file);
  }

  async DeleteAllImgServiceProjectController(
    request: Request,
    response: Response
  ) {
    try {
      const { id } = request.params;
      const imgServiceProjectIds = request.body; // Expecting an array of ids directly

      if (!id) {
        return response
          .status(400)
          .json({ error: "Service project ID is required!" });
      }

      const serviceProject = await prisma.serviceProject.findUnique({
        where: { id },
      });

      if (!serviceProject) {
        return response.status(400).json({ error: "Service project invalid!" });
      }

      if (
        !Array.isArray(imgServiceProjectIds) ||
        imgServiceProjectIds.length === 0
      ) {
        return response
          .status(400)
          .json({ error: "Array of ids is required!" });
      }

      const imgServiceProjects = await prisma.imgServiceProject.findMany({
        where: { id: { in: imgServiceProjectIds }, serviceProjectId: id },
      });

      // Deletar todos os arquivos de imgServiceProject
      for (const img of imgServiceProjects) {
        deleteFile(`./public/tmp/service-project/${img.uri}`);
      }

      // Deletar registros de imgServiceProject do banco de dados
      if (imgServiceProjects.length > 0) {
        await prisma.imgServiceProject.deleteMany({
          where: { id: { in: imgServiceProjectIds }, serviceProjectId: id },
        });
      }

      return response.json(serviceProject.id);
    } catch (error) {
      if (error instanceof Error) {
        return response.json({ error: error.message });
      }
      return response.json({ error: "Internal error" });
    }
  }

  // constructor() {
  //   this.deleteServiceProject = this.deleteServiceProject.bind(this);
  //   this.deleteFiles = this.deleteFiles.bind(this);
  // }

  // deleteFiles(file: string) {
  //   deleteFile(`./public/tmp/service-project/${file}`);
  // }
  // ja estava funcionando tenho que testar se mudou pelo fato de comentar
  //o conteudo acima
  //
  async deleteServiceProject(request: Request, response: Response) {
    try {
      const { id } = request.params;

      // Verificar se o serviço existe
      const serviceProject = await prisma.serviceProject.findUnique({
        where: { id: String(id) }
      });

      if (!serviceProject) {
        return response.status(404).json({ error: "Service Project not found" });
      }


      // Excluir outras entidades relacionadas
      await prisma.galleryBefore.deleteMany({
        where: { serviceProjectId: id },
      });

      await prisma.galleryAfter.deleteMany({
        where: { serviceProjectId: id },
      });

      await prisma.imgServiceProject.deleteMany({
        where: { serviceProjectId: id },
      });

      await prisma.costProject.deleteMany({
        where: { serviceProjectId: id },
      });

      await prisma.activities.deleteMany({
        where: { serviceProjectId: id },
      });

      await prisma.serviceStages.deleteMany({
        where: { serviceProjectId: id },
      });

      await prisma.userServiceProject.deleteMany({
        where: { service_project_id: id },
      });

      await prisma.timeLine.deleteMany({
        where: { service_project_id: id },
      });

      // Agora podemos excluir o ServiceProject com segurança
      await prisma.serviceProject.delete({
        where: {
          id: String(id),
        },
      });

      return response.json({
        message: "Service Project and its related data deleted successfully",
      });
    } catch (error) {
      console.error(error);
      if (error instanceof Error) {
        return response.json({ error: error.message });
      }
      return response.json({ error: "Internal server error" });
    }
  }

  async getServicesByProjectId(req: Request, res: Response) {
    const { id } = req.params;
    try {
      const services = await prisma.serviceProject.findMany({
        where: { projectId: id },
      });
      if (services) {
        res.json(services);
      } else {
        res.status(404).json({ error: "Services not found for this project" });
      }
    } catch (error) {
      if (error instanceof Error) {
        return res.json({ error: error.message });
      }
      return res.json({ error: "Erro interno do servidor" });
    }
  }

  async getUserSeller(request: Request, response: Response) {
    try {
      const { pag, company_id } = request.query; // Alterado para request.query

      const pageNumber = Number(pag) || 0;

      // Find office with name 'Seller'
      const sellerOffice = await prisma.office.findFirst({
        select: { id: true },
        where: { name: "Seller" },
      });

      if (!sellerOffice) {
        return response.status(404).json({ error: "Seller office not found" });
      }
      const isMultiCompany = await isMultiCompanyEnabled()
      let result;
      let total;

      if (isMultiCompany) {
        const whereCondition = {
          AND: [
            { companies: { some: { companyId: String(company_id) } } },
            { office_id: sellerOffice.id },
          ],
        };

        const selectFields = {
          id: true,
          avatar: true,
          name: true,
          email: true,
          document: true,
          phone: true,
          city_and_state: true,
          date_creation: true,
          date_update: true,
        };

        const [users, userCount] = await Promise.all([
          prisma.user.findMany({
            where: whereCondition,
            select: selectFields,
            skip: pageNumber * 20,
            take: 20,
            orderBy: {
              date_creation: "desc",
            },
          }),
          prisma.user.count({
            where: whereCondition,
          })
        ]);

        result = users;
        total = userCount;
      } else {
        const whereCondition = {
          AND: [
            { company_id: { equals: String(company_id) } },
            { office_id: sellerOffice.id },
          ],
        };

        const selectFields = {
          id: true,
          avatar: true,
          name: true,
          email: true,
          document: true,
          phone: true,
          city_and_state: true,
          date_creation: true,
          date_update: true,
        };

        const [users, userCount] = await Promise.all([
          prisma.user.findMany({
            where: whereCondition,
            select: selectFields,
            skip: pageNumber * 20,
            take: 20,
            orderBy: {
              date_creation: "desc",
            },
          }),
          prisma.user.count({
            where: whereCondition,
          })
        ]);

        result = users;
        total = userCount;
      }



      return response.json({ total, result });
    } catch (error) {
      console.error(error);
      if (error instanceof Error) {
        return response.status(500).json({ error: error.message });
      }
      return response.status(500).json({ error: "Internal server error" });
    }
  }

  async updateUserSellerProject(req: Request, res: Response) {
    const { id, seller_user_id } = req.body;
    try {
      const project = await prisma.project.update({
        where: { id },
        data: {
          seller_user_id: seller_user_id,
        },
      });
      return res.json(project);
    } catch (error) {
      if (error instanceof Error) {
        return res.json({ error: error.message });
      }
      return res.json({ error: "Erro interno do servidor" });
    }
  }

  async createProject(req: Request, res: Response) {
    const data: INewProject = req.body;

    try {
      if (!data.seller_user_id) {
        return res.status(400).json({ error: "seller_user_id is required" });
      }
      if (!data.company_id) {
        return res.status(400).json({ error: "company_id is required" });
      }
      if (!data.client) {
        return res.status(400).json({ error: "client data is required" });
      }
      if (!data.client.name || !data.client.email) {
        return res.status(400).json({ error: "client name and email are required" });
      }
      if (!data.location) {
        return res.status(400).json({ error: "location is required" });
      }
      if (!data.lat) {
        return res.status(400).json({ error: "lat is required" });
      }
      if (!data.log) {
        return res.status(400).json({ error: "log is required" });
      }
      if (!data.radius) {
        return res.status(400).json({ error: "radius is required" });
      }

      // Set default values for optional fields
      const price = data.price || 0;
      const status_project = data.status_project || "Pending";

      let client = await prisma.client.findUnique({
        where: {
          email_company_id: {
            email: data.client.email,
            company_id: data.company_id,
          },
        },
      });

      if (client) {
        // Cliente já existe → atualizar apenas os dados básicos
        client = await prisma.client.update({
          where: { id: client.id },
          data: {
            name: data.client.name,
            phone: data.client.phone,
            birth_date: data.client.birth_date,
          },
        });
      } else {
        //  Cliente novo → criar incluindo lat, log, radius
        client = await prisma.client.create({
          data: {
            name: data.client.name,
            email: data.client.email,
            phone: data.client.phone,
            birth_date: data.client.birth_date,
            company_id: data.company_id,
          },
        });
      }

      // Buscar o último estimate da empresa para sincronizar numeração
      const lastEstimate = await prisma.estimate.findFirst({
        where: {
          project: {
            company_id: data.company_id
          }
        },
        select: {
          number: true
        },
        orderBy: {
          number: 'desc'
        }
      });

      // Buscar o último project da empresa para verificar contract_number
      const lastProject = await prisma.project.findFirst({
        where: {
          company_id: data.company_id,
          contract_number: { not: null }
        },
        select: {
          contract_number: true
        },
        orderBy: {
          contract_number: 'desc'
        }
      });

      let lastEstimateNumber = 0;
      if (lastEstimate?.number) {
        const parts = lastEstimate.number.split('/');
        lastEstimateNumber = Number(parts[0]) || 0;
      }

      const lastProjectNumber = Number(lastProject?.contract_number || '0');
      const highestNumber = Math.max(lastEstimateNumber, lastProjectNumber);

      const nextNumber = highestNumber + 1;

      const project = await prisma.project.create({
        data: {
          seller_user_id: data.seller_user_id,
          price: price,
          status_project: status_project,
          client_id: client.id,
          start_date: data.start_date,
          deadline: data.deadline,
          company_id: data.company_id,
          contract_number: nextNumber,
          location: data.location,
          lat: data.lat,
          log: data.log,
          radius: data.radius ? Number(data.radius) : null,
        },
      });

      return res.status(201).json(project);
    } catch (error) {
      if (error instanceof Error) {
        return res.json({ error: error.message });
      }
      return res.json({ error: "Erro interno do servidor" });
    }
  }

  async upLoadPhotoServiceProject(req: Request, res: Response) {
    const { serviceProjectId } = req.body;

    deleteFile(`./public/tmp/service-project/${req.file?.filename}`);
    const filePath = req.file?.filename?.split(".")[0] + ".webp"; // Caminho do arquivo
    const s3Bucket = process.env.AMAZON_S3_BUCKET!;
    const fileName = await uploadImageWebpToS3(
      `./public/tmp/service-project/${filePath}`,
      s3Bucket
    );

    await prisma.imgServiceProject.create({
      data: {
        uri: fileName,
        serviceProjectId,
      },
    });

    deleteFile(`./public/tmp/service-project/${filePath}`);
    return res.json();
  }

  async imageUrlServiceProject(req: Request, res: Response) {
    const { serviceProjectId, url } = req.body;

    try {
      const img = await prisma.imgServiceProject.create({
        data: {
          uri: url,
          serviceProjectId,
        },
      });

      return res.json(img);
    } catch (error) {
      if (error instanceof Error) {
        return res.json({ error: error.message });
      }
      return res.json({ error: "Erro interno do servidor" });
    }
  }

  async updateProject(req: Request, res: Response) {
    const { id } = req.params;
    const { seller_user_id, price, status_project, client_id, autorId } =
      req.body;
    try {
      const project = await prisma.project.update({
        where: { id },
        data: {
          seller_user_id,
          price,
          status_project,
          client_id,
          autorId,
        },
      });
      return res.json(project);
    } catch (error) {
      if (error instanceof Error) {
        return res.json({ error: error.message });
      }
      return res.json({ error: "Erro interno do servidor" });
    }
  }
  async updateStatusProject(req: Request, res: Response) {
    const { id, status } = req.body;
    try {
      const project = await prisma.project.update({
        where: { id },
        data: {
          status_project: status,
        },
      });
      return res.json(project);
    } catch (error) {
      if (error instanceof Error) {
        return res.json({ error: error.message });
      }
      return res.json({ error: "Erro interno do servidor" });
    }
  }

  async startDateProject(req: Request, res: Response) {
    const { id, start_date } = req.body;

    try {
      // Validação do ID
      if (!id) {
        return res.status(400).json({ error: "Invalid or missing 'id'" });
      }

      // Verificar se o projeto existe
      const existingProject = await prisma.project.findUnique({
        where: { id },
      });

      if (!existingProject) {
        return res.status(404).json({ error: "Project not found" });
      }

      // Atualizar a data de início
      const project = await prisma.project.update({
        where: { id },
        data: { start_date },
      });

      return res.json(project);
    } catch (error) {
      console.error(error);
      if (error instanceof Error) {
        return res.status(500).json({ error: error.message });
      }
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async deadlineProject(req: Request, res: Response) {
    const { id, deadline } = req.body;

    try {
      // Validação do ID
      if (!id) {
        return res.status(400).json({ error: "Invalid or missing 'id'" });
      }

      // Verificar se o projeto existe
      const existingProject = await prisma.project.findUnique({
        where: { id },
      });

      if (!existingProject) {
        return res.status(404).json({ error: "Project not found" });
      }

      // Atualizar o prazo final
      const project = await prisma.project.update({
        where: { id },
        data: { deadline },
      });

      return res.json(project);
    } catch (error) {
      console.error(error);
      if (error instanceof Error) {
        return res.status(500).json({ error: error.message });
      }
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async deleteProject(req: Request, res: Response) {
    const {
      id
    } = req.params;

    console.log("Apagando projeto de id:", id)

    if (!id) {
      return res.status(400).json({
        error: "Project id is required"
      })
    }

    const project = await prisma.project.findUnique({
      where: { id }
    })

    if (!project) {
      return res.status(404).json({
        error: "Project not found"
      })
    }

    try {
      await prisma.invoiceCostProject.deleteMany({
        where: {
          project_id: id
        }
      })

      await prisma.serviceProject.deleteMany({
        where: {
          projectId: id
        }
      })

      await prisma.workedhours.deleteMany({
        where: {
          project_id: id
        }
      })

      await prisma.pdfProject.deleteMany({
        where: {
          project_id: id
        }
      })

      await prisma.estimate.deleteMany({
        where: {
          projectId: id
        }
      })

      await prisma.contractProject.deleteMany({
        where: {
          projectId: id
        }
      })

      await prisma.invoice.deleteMany({
        where: {
          projectId: id
        }
      })

      await prisma.project.delete({
        where: { id }
      });
      return res.status(200).json({
        message: "Project deleted successfully",
      })
    } catch (error) {
      if (error instanceof Error) {
        return res.json({ error: error.message });
      }
      return res.json({ error: "Internal server error" });
    }
  }

  async findServicesProjectByProjectId(req: Request, res: Response) {
    const { id } = req.params;
    try {
      // Verificar se o projeto existe
      const existingProject = await prisma.project.findUnique({
        where: { id },
      });

      if (!existingProject) {
        return res.status(404).json({ error: "Project not found" });
      }
      const result = await prisma.serviceProject.findMany({
        where: { projectId: id },
        include: {
          Project: {
            select: {
              id: true,
            },
          },
          photos: {
            select: {
              uri: true,
              id: true,
              date_creation: true,
            },
          },
          stages: true,
          Activities: true,
          UserServiceProject: {
            select: {
              id: true,
              user: {
                select: {
                  id: true,
                  name: true,
                  avatar: true,
                },
              },
            },
          },
        },
      });

      // Processar URLs assinadas
      const processedResult = await Promise.all(
        result.map(async (serviceProject) => ({
          ...serviceProject,
          photos: await Promise.all(
            serviceProject.photos.map(async (photo) => ({
              ...photo,
              uri: photo.uri ? await getPresignedUrl(photo.uri) : null, // Assina o campo `uri`
            }))
          ),
          UserServiceProject: await Promise.all(
            serviceProject.UserServiceProject.map(async (userService) => ({
              ...userService,
              user: {
                ...userService.user,
                avatar: userService.user.avatar
                  ? await getPresignedUrl(userService.user.avatar)
                  : null, // Assina o campo `avatar`
              },
            }))
          ),
        }))
      );

      return res.json(processedResult);
    } catch (error) {
      if (error instanceof Error) {
        return res.json({ error: error.message });
      }
      return res.json({ error: "Internal server error" });
    }
  }

  async findHistoryServicesProjectById(req: Request, res: Response) {
    const { id } = req.params;
    try {
      // Verificar se o projeto existe
      const existingProject = await prisma.serviceProject.findUnique({
        where: { id },
      });

      if (!existingProject) {
        return res.status(404).json({ error: "Service Project not found" });
      }
      const result = await prisma.userAttendance.findMany({
        where: {
          UserServiceProject: {
            service_project_id: {
              equals: id,
            },
          },
        },
        include: {
          UserServiceProject: {
            select: {
              service_project: {
                select: {
                  price: true,
                },
              },
            },
          },
          user: {
            select: {
              id: true,
              name: true,
              avatar: true,
              hourly_price: true,
            },
          },
        },
        orderBy: {
          check_in_time: "desc",
        },
      });

      // Processar URLs assinadas e calcular horas trabalhadas
      const processedResult = await Promise.all(
        result.map(async (attendance) => {
          let hoursWorked = 0;
          if (attendance.check_out_time) {
            hoursWorked = dayjs(attendance.check_out_time).diff(
              dayjs(attendance.check_in_time),
              "hour",
              true
            );
          }
          let regularHours = 0;
          let overtimeHours = 0;

          if (attendance.check_out_time && attendance.check_in_time) {
            const hours = calcularHorasTrabalhadas(
              attendance.check_in_time.toISOString(),
              attendance.check_out_time.toISOString(),
              attendance.workStartTime,
              attendance.workEndTime,
            );
            regularHours = convertHHMMToDecimal(hours.normais);
            overtimeHours = convertHHMMToDecimal(hours.extras);
          }
          return {
            ...attendance,
            user: {
              ...attendance.user,
              avatar: attendance.user.avatar
                ? await getPresignedUrl(attendance.user.avatar)
                : null,
            },
            hours_worked: parseFloat(hoursWorked.toFixed(2)),
            price:
              (regularHours * (attendance.user.hourly_price || 0)) +
              (overtimeHours * (attendance.user.hourly_price || 0) * 1.5),
          };
        })
      );

      return res.json(processedResult);
    } catch (error) {
      if (error instanceof Error) {
        return res.json({ error: error.message });
      }
      return res.json({ error: "Internal server error" });
    }
  }

  async getSellerSchedule(req: Request, res: Response) {
    const { seller_user_id, company_id } = req.body;

    try {
      // Validação do ID do vendedor
      if (!seller_user_id) {
        return res.status(400).json({ error: "Seller user ID is required" });
      }
      const isMultiCompany = await isMultiCompanyEnabled()
      let user = await prisma.user.findUnique({
        where: {
          id: seller_user_id,
        },
        select: {
          office: {
            select: {
              name: true,
            },
          },
          companies: {
            select: {
              office: {
                select: {
                  name: true,
                },
              },

            },
          },
        },
      });


      let projects: any = [];
      if (isMultiCompany && user?.companies.some((x) => x.office.name.toLocaleLowerCase() == "seller") || user?.office.name.toLocaleLowerCase() == "seller") {
        // Buscar os projetos do vendedor
        projects = await prisma.project.findMany({
          where: {
            seller_user_id,
            status_project: {
              in: ["Accepted", "Pre-Start", "In Progress", "Final walkthrough", "Finished"],
            },
          },
          include: {
            client: true, // Inclui os dados do cliente
          },
        });
      } else {
        // Buscar todos os projetos
        projects = await prisma.project.findMany({
          where: {
            company_id,
            status_project: {
              in: ["Accepted", "Pre-Start", "In Progress", "Final walkthrough", "Finished"],
            },
          },
          include: {
            client: true, // Inclui os dados do cliente
          },
        });
      }

      // Transformar os projetos no formato necessário
      const events = projects.map((project: any) => {
        const start = project.start_date
          ? new Date(`${project.start_date}T00:00:00`)
          : project.start_date;
        const end = project.deadline
          ? new Date(`${project.deadline}T23:59:59`)
          : project.deadline; // Inclui o último dia

        // Formatar endereço do cliente
        const description = project.location
          ? project.location
          : "No address available";

        return {
          id: project.id,
          title: project.client?.name || "Unknown Client",
          start: project.start_date || start,
          end: project.deadline || end,
          description,
        };
      });

      // Filtrar eventos válidos (com datas de início e fim)
      const filteredEvents = events.filter(
        (event: any) => event.start && event.end
      );

      return res.json(filteredEvents);
    } catch (error) {
      if (error instanceof Error) {
        return res.status(500).json({ error: error.message });
      }
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  // async getServiceProjectSchedule(req: Request, res: Response) {
  //   const { seller_user_id } = req.body;

  //   try {
  //     // Validação do ID do vendedor
  //     if (!seller_user_id) {
  //       return res.status(400).json({ error: "Seller user ID is required" });
  //     }

  //     // Buscar os ServiceProjects relacionados ao vendedor
  //     const serviceProjects = await prisma.serviceProject.findMany({
  //       where: {
  //         Project: {
  //           seller_user_id,
  //         },
  //       },
  //       include: {
  //         Project: {
  //           include: {
  //             client: true,
  //           },
  //         },
  //       },
  //     });

  //     // Transformar os dados no formato necessário para o calendário
  //     const events = serviceProjects.map((service) => {
  //       const start = service.start_date ? new Date(`${service.start_date}T00:00:00`) : null;
  //       const end = service.deadline ? new Date(`${service.deadline}T23:59:59`) : null;

  //       // Formatar endereço do cliente e informações adicionais
  //       const description = service.Project?.client?.location
  //         ? service.Project.client.location
  //         : "No address available";

  //       const imageUrl = service.Project?.client?.avatar || "/default_avatar.png";

  //       return {
  //         title: service.name,
  //         start,
  //         end,
  //         description,
  //         imageUrl,
  //       };
  //     });

  //     // Filtrar eventos válidos (com datas de início e fim)
  //     const filteredEvents = events.filter((event) => event.start && event.end);

  //     return res.json(filteredEvents);
  //   } catch (error) {
  //     if (error instanceof Error) {
  //       return res.status(500).json({ error: error.message });
  //     }
  //     return res.status(500).json({ error: "Internal server error" });
  //   }
  // }

  async getServiceProjectSchedule(req: Request, res: Response) {
    const { company_id, seller_user_id } = req.body;

    try {
      // Validação do ID da empresa
      if (!company_id) {
        return res.status(400).json({ error: "Company ID is required" });
      }
      // Validação do ID do vendedor
      if (!seller_user_id) {
        return res.status(400).json({ error: "Seller user ID is required" });
      }
      const isMultiCompany = await isMultiCompanyEnabled()
      const user = await prisma.user.findUnique({
        where: {
          id: seller_user_id,
        },
        select: {
          office: {
            select: {
              name: true,
            },
          },
          companies: {
            select: {
              office: {
                select: {
                  name: true,
                },
              },
            },
          },
        },
      });

      let serviceProjects: any = [];
      if (isMultiCompany && user?.companies.some((x) => x.office.name.toLocaleLowerCase() == "seller") || user?.office.name.toLocaleLowerCase() == "seller") {
        // Buscar os ServiceProjects relacionados ao vendedor
        serviceProjects = await prisma.serviceProject.findMany({
          where: {
            Project: {
              seller_user_id,
            },
          },
          include: {
            Project: {
              include: {
                client: true,
              },
            },
            UserServiceProject: {
              include: {
                user: {
                  select: {
                    avatar: true,
                    name: true,
                  },
                },
              },
            },
          },
        });
      } else {
        // Buscar todos os ServiceProjects
        serviceProjects = await prisma.serviceProject.findMany({
          where: {
            Project: {
              company_id: {
                equals: company_id,
              },
            },
          },
          include: {
            Project: {
              include: {
                client: true,
              },
            },
            UserServiceProject: {
              include: {
                user: {
                  select: {
                    avatar: true,
                    name: true,
                  },
                },
              },
            },
          },
        });
      }

      // Transformar os dados no formato necessário para o calendário
      const events = await Promise.all(serviceProjects.map(async (service: any) => {
        const start = service.start_date
          ? new Date(`${service.start_date}T00:00:00`)
          : null;
        const end = service.deadline
          ? new Date(`${service.deadline}T23:59:59`)
          : null;

        // Array de imagens dos usuários vinculados
        const userImages = await Promise.all(
          service.UserServiceProject.map(async (userService: any) => ({
            name: userService.user.name,
            avatar: typeof userService.user.avatar === 'string' && userService.user.avatar !== null
              ? await getPresignedUrl(userService.user.avatar)
              : null,
          }))
        );

        // Formatar descrição e informações adicionais
        const description = service.Project?.location
          ? service.Project.location
          : "No address available";

        return {
          id: service.id,
          idProject: service.Project.id,
          title: service.name,
          start,
          end,
          description,
          userImages, // Array de imagens e nomes
        };
      }));

      // Filtrar eventos válidos (com datas de início e fim)
      const filteredEvents = events.filter(
        (event: any) => event.start && event.end
      );

      return res.json(filteredEvents);
    } catch (error) {
      if (error instanceof Error) {
        return res.status(500).json({ error: error.message });
      }
      return res.status(500).json({ error: "Internal server error" });
    }
  }


  async getServiceProjectScheduleByIdUser(req: Request, res: Response) {
    const { user_id } = req.body;

    try {
      // Validação do ID do usuário
      if (!user_id) {
        return res.status(400).json({ error: "User ID is required" });
      }

      // Buscar os registros na tabela UserServiceProject
      const userServiceProjects = await prisma.userServiceProject.findMany({
        where: {
          user_id: user_id,
        },
        include: {
          service_project: {
            include: {
              Project: {
                select: {
                  id: true,
                  location: true,
                  client: {
                    select: {
                      location: true,
                    },
                  },
                },
              },
            },
          },
        },
      });

      // Verificar se há registros encontrados
      if (userServiceProjects.length === 0) {
        return res
          .status(404)
          .json({ error: "No service projects found for this user." });
      }

      // Filtrar e transformar os dados no formato necessário
      const events = userServiceProjects
        .filter((userServiceProject) => {
          const service = userServiceProject.service_project;
          return service.start_date && service.deadline; // Filtra serviços com ambas as datas presentes
        })
        .map((userServiceProject) => {
          const service = userServiceProject.service_project;

          const initial = service.start_date; // Formato 'YYYY-MM-DD'
          const end = service.deadline; // Formato 'YYYY-MM-DD'
          const description = service.Project?.location
            ? service.Project.location
            : "No address available";

          return {
            id: service.Project?.id || service.id, // Garantir que há um ID válido
            service: service.name,
            initial,
            end,
            description,
          };
        });

      return res.json(events);
    } catch (error) {
      if (error instanceof Error) {
        return res.status(500).json({ error: error.message });
      }
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async getWorkerSchedule(req: Request, res: Response) {
    const { id } = req.params;
    const isMultiCompany = await isMultiCompanyEnabled()
    try {
      // Validação do ID do worker
      if (!id) {
        return res.status(400).json({ error: "Worker user ID is required" });
      }
      const user = await prisma.user.findUnique({
        where: {
          id,
        },
        select: {
          office: {
            select: {
              name: true,
            },
          },
          companies: {
            select: {
              office: {
                select: {
                  name: true,
                },
              },
            },
          },
        },
      });
      if (isMultiCompany && user?.companies.some((x) => x.office.name.toLocaleLowerCase() == "worker") || user?.office.name.toLocaleLowerCase() == "worker") {
        return res
          .status(400)
          .json({ error: "The id entered must be that of a worker" });
        // Buscar os ServiceProjects relacionados ao vendedor
      }
      const serviceProjects = await prisma.serviceProject.findMany({
        where: {
          UserServiceProject: {
            some: {
              user_id: id,
            },
          },
        },
        include: {
          Project: {
            include: {
              client: true,
            },
          },
        },
      });

      // Transformar os dados no formato necessário para o calendário
      const events = serviceProjects.map((service) => {
        const start = service.start_date
          ? new Date(`${service.start_date}T00:00:00`)
          : null;
        const end = service.deadline
          ? new Date(`${service.deadline}T23:59:59`)
          : null;

        // Formatar descrição e informações adicionais
        const description = service.Project?.location
          ? service.Project.location
          : "No address available";

        return {
          title: service.name,
          start,
          end,
          description,
        };
      });

      // Filtrar eventos válidos (com datas de início e fim)
      const filteredEvents = events.filter(
        (event: any) => event.start && event.end
      );

      return res.json(filteredEvents);
    } catch (error) {
      if (error instanceof Error) {
        return res.status(500).json({ error: error.message });
      }
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async updateDatesServiceProject(req: Request, res: Response) {
    const { id, start_date, deadline } = req.body;

    try {
      // Validação do ID
      if (!id) {
        return res.status(400).json({ error: "Invalid or missing 'id'" });
      }

      // Verificar se o serviço existe
      const existingService = await prisma.serviceProject.findUnique({
        where: { id },
      });

      if (!existingService) {
        return res.status(404).json({ error: "ServiceProject not found" });
      }

      // Atualizar as datas apenas se forem fornecidas
      const updateData: { start_date?: string; deadline?: string } = {};
      if (start_date) updateData.start_date = start_date;
      if (deadline) updateData.deadline = deadline;

      const updatedService = await prisma.serviceProject.update({
        where: { id },
        data: updateData,
      });

      return res.json(updatedService);
    } catch (error) {
      console.error(error);
      if (error instanceof Error) {
        return res.status(500).json({ error: error.message });
      }
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async updateStatusServiceProject(req: Request, res: Response) {
    const { id, status } = req.body;

    try {
      // Validação do ID
      if (!id) {
        return res.status(400).json({ error: "Invalid or missing 'id'" });
      }

      // Verificar se o serviço existe
      const existingService = await prisma.serviceProject.findUnique({
        where: { id },
      });

      if (!existingService) {
        return res.status(404).json({ error: "ServiceProject not found" });
      }

      // Atualizar as datas apenas se forem fornecidas
      const updateData: { status?: string } = {};
      if (status) updateData.status = status;

      const updatedService = await prisma.serviceProject.update({
        where: { id },
        data: updateData,
      });

      return res.json(updatedService);
    } catch (error) {
      console.error(error);
      if (error instanceof Error) {
        return res.status(500).json({ error: error.message });
      }
      return res.status(500).json({ error: "Internal server error" });
    }
  }

  async generateAndSendPdf(req: Request, res: Response) {
    const { id } = req.params;
    try {
      // Buscar todas as informações do projeto com base no ID
      const project = await prisma.project.findUnique({
        where: { id },
        include: {
          client: true,
          serviceProject: {
            include: {
              photos: true // Incluindo as fotos dos serviços
            }
          },
          company: {
            select: {
              name: true,
              avatar: true,
              address: true,
              district: true,
              numberHouse: true,
              complement: true,
              email: true,
              phone: true,
              webSiteUrl: true,
              NotesContrac: {
                orderBy: { updatedAt: "asc" },
                select: {
                  id: true,
                  notes: true,
                  updatedAt: true,
                },
              },
            },
          },
        },
      });

      if (!project) {
        return res.status(404).json({ error: "Project not found" });
      }

      if (!project.client) {
        return res.status(400).json({ error: "Client information is missing" });
      }

      // Transformar os dados do projeto no formato esperado por generatePdf
      const tableData = project.serviceProject.map((service, index) => {
        const rate = Number(service.price) * Number(service.hours);
        return {
          id: index + 1,
          date: "",
          productOrService: service.name,
          description: service.description,
          qty: Number(service.hours),
          rate,
          amount: rate,
          photos: service.photos.map(photo => ({
            uri: photo.uri
          }))
        };
      });

      const total = `$${tableData
        .reduce((sum, row) => sum + row.amount, 0)
        .toFixed(2)}`;

      const columnText1 = [
        project.client?.name || "",
        "Bill to",
        project.client?.name || "",
        project.location || "",
        project.client?.city_and_state || "",
      ];

      const columnText2 = [
        "",
        "Ship to",
        project.client?.name || "",
        project.location || "",
        project.client?.city_and_state || "",
      ];

      // --- Buscar os dados da empresa (para os dados do cabeçalho) ---
      // Assumindo que o projeto possua um campo company_id (relacionado à empresa que gera o contrato)
      const companyId = project.company_id;
      if (!companyId) {
        return res.status(404).json({ error: "Company not found" });
      }

      const companyData = await prisma.company.findUnique({
        where: { id: companyId },
        select: {
          name: true,
          avatar: true,
          address: true,
          district: true,
          numberHouse: true,
          complement: true,
          email: true,
          phone: true,
          webSiteUrl: true,
          NotesContrac: {
            orderBy: { updatedAt: "asc" },
            select: {
              id: true,
              notes: true,
              updatedAt: true,
            },
          },
        },
      });

      if (!companyData) {
        return res.status(404).json({ error: "Company not found" });
      }
      // Converter o avatar para um presigned URL, se existir
      const logoUrl = companyData.avatar
        ? await getPresignedUrl(companyData.avatar)
        : null;

      // Montar o endereço completo
      const fullAddress = `${companyData.address}`;

      // Extrair as notas (apenas o texto)
      const notesArray = companyData.NotesContrac.map((note) => note.notes);
      console.log("logo depois de comprimir: ", logoUrl)
      // Preparar o objeto de dados a ser enviado para a função generatePdf
      const data = {
        tableData,
        total,
        columnText1,
        columnText2,
        address: fullAddress || "",
        logoUrl: logoUrl || undefined,
        notes: notesArray,
        phone: companyData.phone || "",
        email: companyData.email || "",
        webSiteUrl: companyData.webSiteUrl || "",
        name: companyData.name,
      };

      // Gerar o PDF
      const pdfPath = await generatePdf(data, project.client.name);

      // Configurar transporte de e-mail
      const SMTP_CONFIG = require("../../config/smtp");
      const transporter = nodemailer.createTransport({
        host: SMTP_CONFIG.host,
        port: SMTP_CONFIG.port,
        secure: SMTP_CONFIG.port === 465, // true for 465, false for other ports
        auth: {
          user: SMTP_CONFIG.user,
          pass: SMTP_CONFIG.pass,
        },
        tls: { rejectUnauthorized: false },
      });

      // Criar template do e-mail
      const templateEmail = createPreviewContract(
        project.client?.name.toUpperCase(),
        logoUrl || '',
        companyData.name,
        Number(total)
      );

      const mailOptions = {
        from: SMTP_CONFIG.user,
        to: project.client.email,
        subject: `Estimate for ${project.client?.name.toUpperCase()}`,
        html: templateEmail,
        attachments: [
          {
            filename: "estimate.pdf",
            path: pdfPath,
          },
        ],
      };

      await transporter.sendMail(mailOptions);

      // Remover o PDF após o envio
      setTimeout(() => {
        fs.unlinkSync(pdfPath);
      }, 5000);

      return res
        .status(200)
        .json({ message: "PDF enviado com sucesso para o cliente!" });
    } catch (error) {
      return res.status(500).json({
        error:
          error instanceof Error ? error.message : "Erro interno do servidor",
      });
    }
  }

  async generateAndSendPdfOther(req: Request, res: Response) {
    const { id } = req.params;
    try {
      // Buscar todas as informações do projeto com base no ID
      const project = await prisma.project.findUnique({
        where: { id },
        include: {
          client: true,
          serviceProject: {
            include: {
              photos: true // Incluindo as fotos dos serviços
            }
          },
          company: {
            select: {
              name: true,
              avatar: true,
              address: true,
              district: true,
              numberHouse: true,
              complement: true,
              email: true,
              phone: true,
              webSiteUrl: true,
              NotesContrac: {
                orderBy: { updatedAt: "asc" },
                select: {
                  id: true,
                  notes: true,
                  updatedAt: true,
                },
              },
            },
          },
        },
      });

      if (!project) {
        return res.status(404).json({ error: "Project not found" });
      }

      if (!project.client) {
        return res.status(400).json({ error: "Client information is missing" });
      }

      // Transformar os dados do projeto no formato esperado por generatePdf
      const tableData = project.serviceProject.map((service, index) => {
        const rate = Number(service.price) * Number(service.hours);
        return {
          id: index + 1,
          date: "",
          productOrService: service.name,
          description: service.description,
          qty: Number(service.hours),
          rate,
          amount: rate,
          photos: service.photos.map(photo => ({
            uri: photo.uri
          }))
        };
      });

      const total = `$${tableData
        .reduce((sum, row) => sum + row.amount, 0)
        .toFixed(2)}`;

      const columnText1 = [
        project.client?.name || "",
        "Bill to",
        project.client?.name || "",
        project.location || "",
        project.client?.city_and_state || "",
      ];

      const columnText2 = [
        "",
        "Ship to",
        project.client?.name || "",
        project.location || "",
        project.client?.city_and_state || "",
      ];

      // --- Buscar os dados da empresa (para os dados do cabeçalho) ---
      // Assumindo que o projeto possua um campo company_id (relacionado à empresa que gera o contrato)
      const companyId = project.company_id;
      if (!companyId) {
        return res.status(404).json({ error: "Company not found" });
      }

      const companyData = await prisma.company.findUnique({
        where: { id: companyId },
        select: {
          name: true,
          avatar: true,
          address: true,
          district: true,
          numberHouse: true,
          complement: true,
          email: true,
          phone: true,
          webSiteUrl: true,
          NotesContrac: {
            orderBy: { updatedAt: "asc" },
            select: {
              id: true,
              notes: true,
              updatedAt: true,
            },
          },
        },
      });

      if (!companyData) {
        return res.status(404).json({ error: "Company not found" });
      }
      // Converter o avatar para um presigned URL, se existir
      const logoUrl = companyData.avatar
        ? await getPresignedUrl(companyData.avatar)
        : null;

      // Montar o endereço completo
      const fullAddress = `${companyData.address}`;

      // Extrair as notas (apenas o texto)
      const notesArray = companyData.NotesContrac.map((note) => note.notes);
      console.log("logo depois de comprimir: ", logoUrl)
      // Preparar o objeto de dados a ser enviado para a função generatePdf
      const data = {
        tableData,
        total,
        columnText1,
        columnText2,
        address: fullAddress || "",
        logoUrl: logoUrl || undefined,
        notes: notesArray,
        phone: companyData.phone || "",
        email: companyData.email || "",
        webSiteUrl: companyData.webSiteUrl || "",
        name: companyData.name,
      };

      // Gerar o PDF
      const pdfPath = await generatePdf(data, project.client.name);

      // Configurar transporte de e-mail
      const SMTP_CONFIG = require("../../config/smtp");
      const transporter = nodemailer.createTransport({
        host: SMTP_CONFIG.host,
        port: SMTP_CONFIG.port,
        secure: SMTP_CONFIG.port === 465, // true for 465, false for other ports
        auth: {
          user: SMTP_CONFIG.user,
          pass: SMTP_CONFIG.pass,
        },
        tls: { rejectUnauthorized: false },
      });

      // Criar template do e-mail
      const templateEmail = createPreviewContract(
        project.client?.name.toUpperCase(),
        logoUrl || '',
        companyData.name,
        Number(total)
      );

      const mailOptions = {
        from: SMTP_CONFIG.user,
        to: project.client.email,
        subject: `Estimate for ${project.client?.name.toUpperCase()}`,
        html: templateEmail,
        attachments: [
          {
            filename: "estimate.pdf",
            path: pdfPath,
          },
        ],
      };

      await transporter.sendMail(mailOptions);

      // Remover o PDF após o envio
      setTimeout(() => {
        fs.unlinkSync(pdfPath);
      }, 5000);

      return res
        .status(200)
        .json({ message: "PDF enviado com sucesso para o cliente!" });
    } catch (error) {
      return res.status(500).json({
        error:
          error instanceof Error ? error.message : "Erro interno do servidor",
      });
    }
  }

  //gera pdf no botão download e dentro de view details no fluxo do link de estimate enviado para o client
  async generatePdfEstimate(req: Request, res: Response) {
    const { id } = req.params;
    try {
      // Buscar todas as informações do projeto com base no ID
      const project = await prisma.project.findUnique({
        where: { id },
        include: {
          client: true,
          serviceProject: {
            include: {
              photos: true // Incluindo as fotos dos serviços
            }
          },
          company: {
            select: {
              name: true,
              avatar: true,
              address: true,
              district: true,
              numberHouse: true,
              complement: true,
              email: true,
              phone: true,
              webSiteUrl: true,
              NotesContrac: {
                orderBy: { updatedAt: "asc" },
                select: {
                  id: true,
                  notes: true,
                  updatedAt: true,
                },
              },
            },
          },
        },
      });

      if (!project) {
        return res.status(404).json({ error: "Project not found" });
      }

      if (!project.client) {
        return res.status(400).json({ error: "Client information is missing" });
      }

      // Transformar os dados do projeto no formato esperado por generatePdf
      const tableData = project.serviceProject.map((service, index) => {
        const rate = Number(service.price) * Number(service.hours);
        return {
          id: index + 1,
          date: "",
          productOrService: service.name,
          description: service.description,
          qty: Number(service.hours),
          rate,
          amount: rate,
          photos: service.photos.map(photo => ({
            uri: photo.uri
          }))
        };
      });

      const total = `$${tableData
        .reduce((sum, row) => sum + row.amount, 0)
        .toFixed(2)}`;

      const columnText1 = [
        project.client?.name || "",
        "Bill to",
        project.client?.name || "",
        project.location || "",
        project.client?.city_and_state || "",
      ];

      const columnText2 = [
        "",
        "Ship to",
        project.client?.name || "",
        project.location || "",
        project.client?.city_and_state || "",
      ];

      // --- Buscar os dados da empresa (para os dados do cabeçalho) ---
      // Assumindo que o projeto possua um campo company_id (relacionado à empresa que gera o contrato)
      const companyId = project.company_id;
      if (!companyId) {
        return res.status(404).json({ error: "Company not found" });
      }

      const companyData = await prisma.company.findUnique({
        where: { id: companyId },
        select: {
          name: true,
          avatar: true,
          address: true,
          district: true,
          numberHouse: true,
          complement: true,
          email: true,
          phone: true,
          webSiteUrl: true,
          NotesContrac: {
            orderBy: { updatedAt: "asc" },
            select: {
              id: true,
              notes: true,
              updatedAt: true,
            },
          },
        },
      });

      if (!companyData) {
        return res.status(404).json({ error: "Company not found" });
      }

      // Converter o avatar para um presigned URL, se existir
      const logoUrl = companyData.avatar
        ? await getPresignedUrl(companyData.avatar)
        : null;

      // Montar o endereço completo
      const fullAddress = `${companyData.address}`;

      // Sanitizar as notas antes de passá-las para o PDF
      const sanitizedNotes = companyData.NotesContrac.map(note => {
        // Substituir tabulações por espaços
        return (note.notes || "").replace(/\t/g, '    ');
      }) || [];



      // Preparar o objeto de dados a ser enviado para a função generatePdf
      const data = {
        tableData,
        total,
        columnText1,
        columnText2,
        address: fullAddress || "",
        logoUrl: logoUrl || undefined,
        notes: sanitizedNotes,
        phone: companyData.phone || "",
        email: companyData.email || "",
        webSiteUrl: companyData.webSiteUrl || "",
        name: companyData.name,
      };

      // para baixar o pdf sem deixar o arquivo salvo no servidor
      const pdfPath = await generatePdf(data, project.client.name, true);

      // Ler o arquivo PDF
      const pdfBuffer = fs.readFileSync(pdfPath);

      // Configurar os headers para download do PDF
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="estimate_${project.contract_number || project.id}.pdf"`);

      // Enviar o PDF como resposta
      res.send(pdfBuffer);

      // Remover o arquivo PDF após o envio
      setTimeout(() => {
        fs.unlinkSync(pdfPath);
      }, 1000);


    } catch (error) {
      console.error("Erro ao gerar PDF:", error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : "Erro interno do servidor",
      });
    }
  }
}
